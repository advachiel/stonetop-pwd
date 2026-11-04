import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	crewIndividualsChanged,
	crewResidentFields,
	syncCrewResidents,
} from "../../../module/actors/character/crew-residents.js";

// A Marshal's crew roster names people of Stonetop. Each named individual gets a Person
// (npc) Actor on the steading's Residents roster, linked back to the roster row so later
// saves follow that same person instead of minting another one.

let actors;
let nextId;

function makeCharacter(individuals, { name = "Rook" } = {}) {
	const actor = {
		id: "pc1",
		uuid: "Actor.pc1",
		name,
		type: "character",
		flags: { "stonetop-pwd": { crew: { individuals, size: individuals.length } } },
		getFlag: (scope, key) => foundry.utils.getProperty(actor.flags, `${scope}.${key}`),
		update: vi.fn(async data => {
			for (const [path, value] of Object.entries(data)) {
				const parts = path.split(".");
				let node = actor.flags;
				for (let i = 1; i < parts.length - 1; i++) node = node[parts[i]];
				node[parts.at(-1)] = value;
			}
			return actor;
		}),
	};
	return actor;
}

function makeSteading(residents = []) {
	const flags = { "stonetop-pwd": { steading: { residents: [...residents] } } };
	return {
		id: "steading-1",
		uuid: "Actor.steading-1",
		name: "Stonetop",
		type: "stonetop",
		flags,
		getFlag: (scope, key) => foundry.utils.getProperty(flags, `${scope}.${key}`),
		typedActor: {
			addPersonRow: vi.fn(async (list, actor) => {
				flags["stonetop-pwd"].steading[list].push({
					uuid: actor.uuid, id: actor.id, name: actor.name, checked: false,
				});
			}),
		},
	};
}

function residentsOf(steading) {
	return steading.flags["stonetop-pwd"].steading.residents;
}

beforeEach(() => {
	actors = [];
	nextId = 0;
	global.game.user = { isGM: true, id: "gm1" };
	global.game.actors = {
		get: id => actors.find(a => a.id === id) ?? null,
		find: fn => actors.find(fn) ?? null,
		contents: actors,
	};
	global.game.folders = { find: () => ({ id: "folder-1" }) };
	global.Folder = { canUserCreate: () => true, create: async () => ({ id: "folder-1" }) };
	global.CONST = { DOCUMENT_OWNERSHIP_LEVELS: { OBSERVER: 2 } };
	global.Actor = {
		create: vi.fn(async data => {
			const id = `npc${++nextId}`;
			const npc = {
				id,
				uuid: `Actor.${id}`,
				name: data.name,
				type: data.type,
				system: { ...data.system },
				img: data.img ?? "icons/svg/mystery-man.svg",
				folder: data.folder ?? null,
				update: vi.fn(async patch => {
					if (patch.name) npc.name = patch.name;
					for (const [key, value] of Object.entries(patch)) {
						if (key.startsWith("system.")) npc.system[key.slice("system.".length)] = value;
					}
					if ("folder" in patch) npc.folder = patch.folder;
				}),
			};
			actors.push(npc);
			return npc;
		}),
	};
});

afterEach(() => {
	delete global.game.user;
	delete global.game.actors;
	delete global.game.folders;
	delete global.Folder;
	delete global.CONST;
	delete global.Actor;
});

describe("crewResidentFields", () => {
	it("carries the name, tag, traits and crew across to the Person", () => {
		expect(crewResidentFields({ name: "Wren", tag: "hardened", traits: ["missing eye", "gruff"] }, { name: "Rook" }))
			.toMatchObject({
				name: "Wren",
				traits: "hardened, missing eye, gruff",
				relations: "Crew of Rook",
				home: "Stonetop",
			});
	});

	it("does not carry the placeholder face onto a new Person", () => {
		expect(crewResidentFields({ name: "Tam", img: "icons/svg/mystery-man.svg" }).img).toBe("");
	});
});

describe("syncCrewResidents", () => {
	it("makes one Person per NAMED member and files each on the Residents roster", async () => {
		const actor = makeCharacter([
			{ name: "Wren", tag: "hardened", traits: ["missing eye"] },
			{ name: "" },
			{ name: "Tam" },
		]);
		const steading = makeSteading();

		const result = await syncCrewResidents(actor, { steading });

		expect(result.created).toBe(2);
		expect(actors.map(npc => npc.name)).toEqual(["Wren", "Tam"]);
		expect(actors[0].system).toMatchObject({ home: "Stonetop", relations: "Crew of Rook" });
		expect(residentsOf(steading).map(row => row.name)).toEqual(["Wren", "Tam"]);
		// The roster rows now point at their Person, which is what makes the sync idempotent.
		expect(actor.flags["stonetop-pwd"].crew.individuals[0]).toMatchObject({ uuid: "Actor.npc1", id: "npc1" });
		expect(actor.flags["stonetop-pwd"].crew.individuals[2]).toMatchObject({ uuid: "Actor.npc2", id: "npc2" });
	});

	it("does nothing on a second run, and never duplicates a resident", async () => {
		const actor = makeCharacter([{ name: "Wren" }, { name: "Tam" }]);
		const steading = makeSteading();
		await syncCrewResidents(actor, { steading });
		const addCalls = steading.typedActor.addPersonRow.mock.calls.length;

		const again = await syncCrewResidents(actor, { steading });

		expect(again).toEqual({ created: 0, linked: 0, updated: 0 });
		expect(actors).toHaveLength(2);
		expect(steading.typedActor.addPersonRow).toHaveBeenCalledTimes(addCalls);
	});

	it("follows a renamed individual onto their Person", async () => {
		const actor = makeCharacter([{ name: "Wren" }]);
		const steading = makeSteading();
		await syncCrewResidents(actor, { steading });
		actor.flags["stonetop-pwd"].crew.individuals[0].name = "Wrenna";

		const result = await syncCrewResidents(actor, { steading });

		expect(result.updated).toBe(1);
		expect(actors).toHaveLength(1);
		expect(actors[0].name).toBe("Wrenna");
		expect(residentsOf(steading)).toHaveLength(1);
	});

	it("adopts a resident who already shares the member's name", async () => {
		const existing = {
			id: "npc-old", uuid: "Actor.npc-old", name: "Wren", type: "npc",
			system: { home: "Stonetop" }, folder: "folder-1", update: vi.fn(),
		};
		actors.push(existing);
		const actor = makeCharacter([{ name: "Wren" }]);
		const steading = makeSteading([{ uuid: existing.uuid, id: existing.id, name: "Wren" }]);

		const result = await syncCrewResidents(actor, { steading });

		expect(result.created).toBe(0);
		expect(actors).toHaveLength(1);
		expect(actor.flags["stonetop-pwd"].crew.individuals[0]).toMatchObject({ uuid: existing.uuid, id: existing.id });
	});

	it("leaves an all-anonymous crew alone", async () => {
		const actor = makeCharacter([], { name: "Rook" });
		actor.flags["stonetop-pwd"].crew.size = 6;

		const result = await syncCrewResidents(actor, { steading: makeSteading() });

		expect(result).toEqual({ created: 0, linked: 0, updated: 0 });
		expect(global.Actor.create).not.toHaveBeenCalled();
	});
});

describe("crewIndividualsChanged", () => {
	it("sees a roster write under the nested flag path", () => {
		expect(crewIndividualsChanged({
			flags: { "stonetop-pwd": { crew: { individuals: [{ name: "Wren" }] } } },
		})).toBe(true);
	});

	it("ignores every other crew write", () => {
		expect(crewIndividualsChanged({ flags: { "stonetop-pwd": { crew: { tags: ["group"] } } } })).toBe(false);
		expect(crewIndividualsChanged({ flags: { "stonetop-pwd": { crew: { size: 7 } } } })).toBe(false);
		expect(crewIndividualsChanged({ name: "Rook" })).toBe(false);
		expect(crewIndividualsChanged(undefined)).toBe(false);
	});
});

// The named members of a Marshal's crew are people of Stonetop, not just rows on a
// follower card. When a crew roster is written — a member named, renamed, or one more
// added to it — each NAMED individual gets a Person (`npc`) Actor on the steading's
// Residents of Stonetop roster, and the link back to that Actor is stamped onto the
// roster row (`crew.individuals[i].uuid`/`.id`). Later writes follow the same Actor
// instead of minting a second one, so the feature is idempotent however often the roster
// is saved.
//
// Only named individuals are made into people. The anonymous tail of the roster is the
// rank and file the rules never name, and a village full of "Crew Member 3" NPCs would be
// noise; naming one promotes them to an individual (StonetopCharacterSheet's Name dialog),
// and that write brings them here.
import { SYSTEM_ID } from "../../system-id.js";
import { readableFlags } from "./StonetopFlags.js";
import { HOME_STONETOP, createPersonNpc, ensurePeopleFolder, personRowActor, steadingListActors } from "../steading/steading-people.js";
import { getStonetopSteadingActor } from "../../utils/world.js";
import { isDefaultImg } from "../../utils/strings.js";
import { isPrimaryGM } from "../../utils/primary-gm.js";

const NO_CHANGES = Object.freeze({ created: 0, linked: 0, updated: 0 });

// Syncs in flight, one per character. The link write this makes is itself an updateActor,
// and without this a second pass would start before the first has finished writing what it
// found — and a slow Actor.create could be answered with a duplicate creation.
const _syncing = new Set();

/** A character's stored crew, or {} when they have none (read across legacy flag scopes). */
function crewOf(actor) {
	return readableFlags(actor)?.crew ?? {};
}

/** The crew's named individuals, in roster order (unnamed rows are filtered nowhere here). */
export function crewIndividualsOf(actor) {
	const individuals = crewOf(actor).individuals;
	return Array.isArray(individuals) ? individuals : [];
}

/** Whether one individual is a person the roster has actually named. */
export function isNamedCrewIndividual(individual) {
	return !!String(individual?.name ?? "").trim();
}

/**
 * The Person (npc) fields a crew member is written with.
 *
 * A crew member's tag and traits are their defining details on the card, so they become
 * the person's Traits line; the crew they belong to goes into Relations, which is where
 * the Residents roster shows it. Home is Stonetop (the crew are villagers), and the
 * individual's chosen face comes across when they have one.
 *
 * @param {object} individual  one row of `crew.individuals`
 * @param {Actor}  keeper      the character whose crew this is
 */
export function crewResidentFields(individual, keeper = null) {
	const name = String(individual?.name ?? "").trim();
	const traits = [
		individual?.tag,
		...(Array.isArray(individual?.traits) ? individual.traits : []),
	].map(t => String(t ?? "").trim()).filter(Boolean).join(", ");
	return {
		name,
		occupation: "",
		traits,
		relations: keeper?.name ? `Crew of ${keeper.name}` : "Crew",
		home:       HOME_STONETOP,
		notes:      "",
		img:        !isDefaultImg(individual?.img ?? "") ? individual.img : "",
		portraitFrame: individual?.portraitFrame ?? null,
	};
}

/**
 * The update paths a linked Person needs to follow their roster row, limited to what the
 * roster owns: their name and their Traits line. Home and Relations are seeded at creation
 * and then left to the GM, along with every other field the NPC sheet carries.
 */
export function crewResidentPatch(npc, fields) {
	const patch = {};
	if (npc?.name !== fields.name) patch.name = fields.name;
	if (String(npc?.system?.traits ?? "") !== fields.traits) patch["system.traits"] = fields.traits;
	return patch;
}

/** The Person an individual already points at, or null. */
function linkedResident(individual) {
	if (!individual?.uuid && !individual?.id) return null;
	const npc = personRowActor({ uuid: individual.uuid, id: individual.id });
	return npc?.type === "npc" ? npc : null;
}

/** A resident already on the roster under this name, so a second person of one name is never made. */
function residentNamed(name, steading) {
	const target = name.trim().toLowerCase();
	if (!target) return null;
	return steadingListActors("residents", steading)
		.find(npc => String(npc?.name ?? "").trim().toLowerCase() === target) ?? null;
}

/** Whether the Person is already listed on the steading's Residents roster. */
function residentListed(npc, steading) {
	const rows = steading?.flags?.[SYSTEM_ID]?.steading?.residents;
	if (!Array.isArray(rows) || !npc) return false;
	return rows.some(row =>
		(row?.uuid && row.uuid === npc.uuid) ||
		(row?.id && row.id === npc.id));
}

/** Put an existing, unparented Person in the Residents of Stonetop folder. Best-effort. */
async function fileAsResident(npc) {
	if (!npc || npc.folder) return;
	const folder = await ensurePeopleFolder("residents");
	if (!folder?.id) return;
	try { await npc.update({ folder: folder.id }); }
	catch (err) { console.warn("Stonetop | Could not file", npc?.name, "under Residents of Stonetop.", err); }
}

/**
 * Bring every named member of a character's crew onto the steading's Residents roster.
 *
 * For each named individual: reuse the Person already linked to it; else adopt a resident
 * with the same name; else create one (in the Residents of Stonetop folder, shared with
 * the table, with Stonetop as Home). The roster row is then stamped with the Person's
 * uuid/id, which is what makes a second run — and a second save — a no-op.
 *
 * Best-effort throughout: this rides a play-time write, and a world whose GM has narrowed
 * permissions must not fail the roster save that triggered it. Whatever could not be made
 * is left unlinked and is picked up by the next save or the load-time sweep.
 *
 * @param {Actor} actor                 a character
 * @param {object} [options]
 * @param {Actor|null} [options.steading]  the steading to file rows on; defaults to the world's
 * @returns {Promise<{created: number, linked: number, updated: number}>}
 */
export async function syncCrewResidents(actor, { steading = null } = {}) {
	if (actor?.type !== "character") return NO_CHANGES;
	if (_syncing.has(actor.id)) return NO_CHANGES;
	_syncing.add(actor.id);
	try {
		return await _syncCrewResidents(actor, steading ?? getStonetopSteadingActor());
	} finally {
		_syncing.delete(actor.id);
	}
}

async function _syncCrewResidents(actor, steading) {
	const individuals = crewIndividualsOf(actor);
	const summary = { created: 0, linked: 0, updated: 0 };
	if (!individuals.some(isNamedCrewIndividual)) return summary;

	const links = new Map();
	for (const [index, individual] of individuals.entries()) {
		if (!isNamedCrewIndividual(individual)) continue;
		const fields = crewResidentFields(individual, actor);
		let npc = linkedResident(individual);

		if (!npc) {
			npc = residentNamed(fields.name, steading);
			if (npc) summary.linked++;
		}
		if (!npc) {
			try {
				npc = await createPersonNpc("residents", fields);
				if (npc) summary.created++;
			} catch (err) {
				console.warn("Stonetop | Could not make a resident for crew member", fields.name, err);
				npc = null;
			}
		} else {
			await fileAsResident(npc);
		}
		if (!npc) continue;

		if (!residentListed(npc, steading)) {
			try { await steading?.typedActor?.addPersonRow?.("residents", npc); }
			catch (err) { console.warn("Stonetop | Could not list crew member", npc?.name, "on the Residents roster.", err); }
		}

		// A Person's name and Traits follow the roster row they stand for. A failed update
		// leaves the link in place, so the next save will try again rather than duplicate them.
		const patch = crewResidentPatch(npc, fields);
		if (Object.keys(patch).length) {
			try { await npc.update(patch); summary.updated++; }
			catch (err) { console.warn("Stonetop | Could not update crew member", npc?.name, err); }
		}

		links.set(index, { uuid: npc.uuid, id: npc.id });
	}
	if (!links.size) return summary;

	// Stamp the links back onto the roster as it stands NOW: everything above awaited, so
	// re-read rather than write the array this pass started with. An index whose row no
	// longer names the same person (someone edited the roster meanwhile) is left alone; the
	// update it came with will sync that row itself.
	const live = crewIndividualsOf(actor);
	let dirty = false;
	const next = live.map((individual, index) => {
		const link = links.get(index);
		if (!link) return individual;
		if (individual?.uuid === link.uuid && individual?.id === link.id) return individual;
		if (String(individual?.name ?? "").trim() !== String(individuals[index]?.name ?? "").trim()) return individual;
		dirty = true;
		return { ...individual, ...link };
	});
	if (dirty) {
		try {
			await actor.update({ [`flags.${SYSTEM_ID}.crew.individuals`]: next }, { render: false });
		} catch (err) {
			console.warn("Stonetop | Could not stamp crew members with their resident links.", err);
		}
	}
	return summary;
}

/**
 * Does this update write a character's crew roster? Foundry expands a dotted flag path
 * into nested `changes`, and a whole-object `crew` replacement has to be caught too.
 */
export function crewIndividualsChanged(changes) {
	const crew = changes?.flags?.[SYSTEM_ID]?.crew;
	return !!crew && crew.individuals !== undefined;
}

/**
 * `updateActor` hook: a Marshal's crew roster changed, so its named members belong on the
 * Residents roster. Runs on the primary GM only — the same rule as the text→NPC sweep
 * (steading-people.js#onSteadingPeopleUpdate), because two GMs both answering this write
 * would race the same Actor creations.
 */
export async function onCrewRosterUpdate(actor, changes) {
	if (actor?.type !== "character" || !game.user?.isGM || !isPrimaryGM()) return;
	if (!crewIndividualsChanged(changes)) return;
	try { await syncCrewResidents(actor); }
	catch (err) { console.error("Stonetop | Crew → Residents sync failed for", actor?.name, err); }
}

/**
 * Load-time sweep for every character: brings existing crews (whose named members predate
 * this feature, or which were saved while no GM was connected) up to date. Idempotent by
 * the links it writes, so it can run on every load. Primary-GM only, like the hook.
 *
 * @returns {Promise<number>} how many Person Actors were created
 */
export async function syncAllCrewResidents() {
	if (!game.user?.isGM || !isPrimaryGM()) return 0;
	let created = 0;
	const characters = (game.actors?.contents ?? []).filter(a => a.type === "character");
	for (const actor of characters) {
		if (!crewIndividualsOf(actor).some(isNamedCrewIndividual)) continue;
		try { created += (await syncCrewResidents(actor)).created; }
		catch (err) { console.error("Stonetop | Crew → Residents sweep failed for", actor?.name, err); }
	}
	return created;
}

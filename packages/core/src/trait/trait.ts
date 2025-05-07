import { $internal } from '../common';
import { Entity } from '../entity/types';
import { ENTITY_ID_MASK, getEntityId } from '../entity/utils/pack-entity';
import { setChanged } from '../query/modifiers/changed';
import { getRelationTargets, Pair, Wildcard } from '../relation/relation';
import { incrementWorldBitflag } from '../world/utils/increment-world-bit-flag';
import { World } from '../world/world';
import { TraitData } from './trait-data';
import { ConfigurableTrait, ExtractStore, Norm, Schema, Store, Trait, TraitType } from './types';
import {
	createFastSetChangeFunction,
	createFastSetFunction,
	createGetFunction,
	createSetFunction,
} from './utils/create-accessors';
import { createStore } from './utils/create-store';

let traitId = 0;

function defineTrait(): Trait<{}>;
function defineTrait<S extends Schema>(schema: S): Trait<Norm<S>>;
function defineTrait<S extends Schema>(schema: S = {} as S): Trait<any> {
	const isAoS = typeof schema === 'function';
	const traitType: TraitType = isAoS ? 'aos' : 'soa';

	const Trait = Object.assign(
		function (params: Partial<Norm<S>>) {
			return [Trait, params];
		},
		{
			schema: schema as Norm<S>,
			[$internal]: {
				set: createSetFunction[traitType](schema),
				fastSet: createFastSetFunction[traitType](schema),
				fastSetWithChangeDetection: createFastSetChangeFunction[traitType](schema),
				get: createGetFunction[traitType](schema),
				stores: [] as Store<S>[],
				id: traitId++,
				createStore: () => createStore(schema as Norm<S>),
				isPairTrait: false,
				relation: null,
				pairTarget: null,
				isTag: !isAoS && Object.keys(schema).length === 0,
				type: traitType,
			},
		}
	) as any;

	return Trait;
}

export const trait = defineTrait;

export function registerTrait(world: World, trait: Trait) {
	const ctx = world[$internal];
	const data = new TraitData(world, trait);

	// Add trait to the world.
	ctx.traitData.set(trait, data);
	world.traits.add(trait);

	// Increment the world bitflag.
	incrementWorldBitflag(world);
}
// need to spend more time w this func
/// (and this file)
export function addTrait(world: World, entity: Entity, ...traits: ConfigurableTrait[]) {
	const ctx = world[$internal];

	for (let i = 0; i < traits.length; i++) {
		// Get trait and params.
		let trait: Trait;
		let params: Record<string, any> | undefined;

		if (Array.isArray(traits[i])) {
			[trait, params] = traits[i] as [Trait, Record<string, any>];
		} else {
			trait = traits[i] as Trait;
		}

		// Exit early if the entity already has the trait.
		if (hasTrait(world, entity, trait)) return;

		const traitCtx = trait[$internal];

		// Register the trait if it's not already registered.
		if (!ctx.traitData.has(trait)) registerTrait(world, trait);

		const data = ctx.traitData.get(trait)!;
		const { generationId, bitflag, queries } = data;

		// Add bitflag to entity bitmask.
		const eid = getEntityId(entity);
		ctx.entityMasks[generationId][eid] |= bitflag;

		// Set the entity as dirty.
		for (const dirtyMask of ctx.dirtyMasks.values()) {
			if (!dirtyMask[generationId]) dirtyMask[generationId] = [];
			dirtyMask[generationId][eid] |= bitflag;
		}

		// Update queries.
		for (const query of queries) {
			// Remove this entity from toRemove if it exists in this query.
			query.toRemove.remove(entity);

			// Check if the entity matches the query.
			let match = query.check(world, entity, { type: 'add', traitData: data });

			if (match) query.add(entity);
			else query.remove(world, entity);
		}

		// Add trait to entity internally.
		ctx.entityTraits.get(entity)!.add(trait);

		const relation = traitCtx.relation;
		const target = traitCtx.pairTarget;

		// Add relation target entity.
		if (traitCtx.isPairTrait && relation !== null && target !== null) {
			// Mark entity as a relation target.
			ctx.relationTargetEntities.add(target);

			// Add wildcard relation traits.
			addTrait(world, entity, Pair(Wildcard, target));
			addTrait(world, entity, Pair(relation, Wildcard));

			// If it's an exclusive relation, remove the old target.
			if (relation[$internal].exclusive === true && target !== Wildcard) {
				const oldTarget = getRelationTargets(world, relation, entity)[0];

				if (oldTarget !== null && oldTarget !== undefined && oldTarget !== target) {
					removeTrait(world, entity, relation(oldTarget));
				}
			}
		}

		if (traitCtx.type === 'soa') {
			// Set default values or override with provided params.
			const defaults: Record<string, any> = {};
			// Execute any functions in the schema for default values.
			for (const key in data.schema) {
				if (typeof data.schema[key] === 'function') {
					defaults[key] = data.schema[key]();
				} else {
					defaults[key] = data.schema[key];
				}
			}

			setTrait(world, entity, trait, { ...defaults, ...params }, false);
		} else {
			const state = params ?? data.schema();
			setTrait(world, entity, trait, state, false);
		}

		// Call add subscriptions.
		for (const sub of data.addSubscriptions) {
			sub(entity);
		}
	}
}

export function removeTrait(world: World, entity: Entity, ...traits: Trait[]) {
	const ctx = world[$internal];

	for (let i = 0; i < traits.length; i++) {
		const trait = traits[i];
		const traitCtx = trait[$internal];

		// Exit early if the entity doesn't have the trait.
		if (!hasTrait(world, entity, trait)) return;

		const data = ctx.traitData.get(trait)!;
		const { generationId, bitflag, queries } = data;

		// Call remove subscriptions before removing the trait.
		for (const sub of data.removeSubscriptions) {
			sub(entity);
		}

		// Remove bitflag from entity bitmask.
		const eid = getEntityId(entity);
		ctx.entityMasks[generationId][eid] &= ~bitflag;

		// Set the entity as dirty.
		for (const dirtyMask of ctx.dirtyMasks.values()) {
			dirtyMask[generationId][eid] |= bitflag;
		}

		// Update queries.
		for (const query of queries) {
			// Check if the entity matches the query.
			let match = query.check(world, entity, { type: 'remove', traitData: data });

			if (match) query.add(entity);
			else query.remove(world, entity);
		}

		// Remove trait from entity internally.
		ctx.entityTraits.get(entity)!.delete(trait);

		// Remove wildcard relations if it is a Pair trait.
		if (traitCtx.isPairTrait) {
			// Check if entity is still a subject of any relation or not.
			if (world.query(Wildcard(entity)).length === 0) {
				ctx.relationTargetEntities.delete(entity);

				// TODO: cleanup query by hash
				// removeQueryByHash(world, [Wildcard(eid)])
			}

			// Remove wildcard to this target for this entity.
			const target = traitCtx.pairTarget!;
			removeTrait(world, entity, Pair(Wildcard, target));

			// Remove wildcard relation if the entity has no other relations.
			const relation = traitCtx.relation!;
			const otherTargets = getRelationTargets(world, relation, entity);

			if (otherTargets.length === 0) {
				removeTrait(world, entity, Pair(relation, Wildcard));
			}
		}
	}
}

export function hasTrait(world: World, entity: Entity, trait: Trait): boolean {
	const ctx = world[$internal];
	const data = ctx.traitData.get(trait);
	if (!data) return false;

	const { generationId, bitflag } = data;
	const eid = getEntityId(entity);
	const mask = ctx.entityMasks[generationId][eid];

	return (mask & bitflag) === bitflag;
}

export function getStore<C extends Trait = Trait>(world: World, trait: C): ExtractStore<C> {
	const ctx = world[$internal];
	const data = ctx.traitData.get(trait)!;
	let store;
	try {
		store = data.store as ExtractStore<C>;
	} catch (e) {
		console.log({ e });
		debugger;
	}
	//@ts-ignore
	return store;
}

export function setTrait(
	world: World,
	entity: Entity,
	trait: Trait,
	value: any,
	triggerChanged = true
) {
	const ctx = trait[$internal];
	const index = entity & ENTITY_ID_MASK;
	const store = getStore(world, trait);

	// A short circuit is more performance than an if statement which creates a new code statement.
	value instanceof Function && (value = value(ctx.get(index, store)));

	ctx.set(index, store, value);
	triggerChanged && setChanged(world, entity, trait);
}

export function getTrait(world: World, entity: Entity, trait: Trait) {
	const worldCtx = world[$internal];
	const data = worldCtx.traitData.get(trait);

	// If the trait does not exist on the world return undefined.
	if (!data) return undefined;

	// Get entity index/id.
	const index = getEntityId(entity);

	// If the entity does not have the trait return undefined.
	const mask = worldCtx.entityMasks[data.generationId][index];
	if ((mask & data.bitflag) !== data.bitflag) return undefined;

	// Return a snapshot of the trait state.
	const traitCtx = trait[$internal];
	const store = getStore(world, trait);
	return traitCtx.get(index, store);
}

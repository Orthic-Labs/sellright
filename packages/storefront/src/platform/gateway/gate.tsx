// Brand views gateway (plan §1, §2): the handle factories. A handle is an INLINE function component, so it adds no component boundary
// and the raw component renders exactly as it did when L1 rendered it directly. Each render it
//   - rebuilds every data prop from the handle's schema (schema.ts `detach`: new objects, rejection instead of silent dropping),
//   - accepts an action prop only as a platform action handle allowed for that prop, and re-wraps it (`bindAction`) so presentation's
//     arguments and every result pass the action's fixed schemas (actions.ts `invokeAction`),
//   - refuses caller children: a component can read `props.children`, so L1 markup never crosses. A handle that needs children builds
//     them itself from validated data (`compose`).
// The checks live inside the handle, so an alias (`const View = ProductCardView`), a conditional choice or a render helper keeps them.
import { $, type JSXOutput } from '@qwik.dev/core';
import { getSlot } from '~/components/slots';
import type { SlotName } from '~/components/slots/registry';
import { checkHandle, invokeAction, type ActionHandle, type ActionName, type BoundAction } from './actions';
import { GatewayError, detach, detachValue, type Infer, type Schema } from './schema';

export interface ActionProp<N extends ActionName = ActionName> {
	readonly names: readonly N[];
	readonly optional: boolean;
}
/** A required action prop accepting these platform actions. */
export const action = <const N extends ActionName>(...names: N[]): ActionProp<N> & { readonly optional: false } => ({ names, optional: false });
/** An action prop the caller may leave out. */
export const optionalAction = <const N extends ActionName>(...names: N[]): ActionProp<N> & { readonly optional: true } => ({ names, optional: true });

type ActionMap = { readonly [prop: string]: ActionProp };

export interface GateDef<D extends Schema, A extends ActionMap> {
	/** The schema of the data props, as one object (or anyOf of objects). */
	readonly data: D;
	readonly actions?: A;
	/** Builds the raw props and children from the validated data (only for handles whose raw component takes children). */
	readonly compose?: (data: Infer<D>) => { props: Record<string, unknown>; children: JSXOutput };
}

type HandleProps<A extends ActionMap> = {
	readonly [K in keyof A as A[K]['optional'] extends true ? never : K]: ActionHandle<A[K]['names'][number]>;
} & {
	readonly [K in keyof A as A[K]['optional'] extends true ? K : never]?: ActionHandle<A[K]['names'][number]>;
};

/** The props a handle takes: its data (readonly, any shape the schema accepts) and its platform action handles. */
export type GateProps<D extends Schema, A extends ActionMap> = Infer<D> & HandleProps<A>;

/** The QRL presentation code gets for a platform action: arguments and result go through the action's schemas. */
export function bindAction<N extends ActionName>(handle: ActionHandle<N>): BoundAction<N> {
	const name = handle.name;
	const run = handle.run;
	return $((...args: unknown[]) => invokeAction(name, run, args)) as unknown as BoundAction<N>;
}

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const emptyChildren = (c: unknown) => c === undefined || c === null || c === false || (Array.isArray(c) && c.length === 0);

/** Any handle definition, without its inferred data type (keeps the checker out of deep schema instantiation). */
export interface AnyGateDef {
	readonly data: Schema;
	readonly actions?: ActionMap;
	readonly compose?: unknown;
}

/** Validates a handle's props and returns what the raw component receives. Exported for tests. */
export function enter(name: string, def: AnyGateDef, props: object): { props: Record<string, unknown>; children: JSXOutput | undefined } {
	const actions: ActionMap = def.actions ?? {};
	const source = props as Record<string, unknown>;
	const data: Record<string, unknown> = {};
	for (const key of Object.keys(source)) {
		if (key === 'children') {
			if (!emptyChildren(source.children)) throw new GatewayError(`${name}.children`, 'L1 markup is not handed to presentation code');
			continue;
		}
		if (!hasOwn(actions, key)) data[key] = source[key];
	}
	const safe: unknown = detachValue(def.data, data, name);
	const bound: Record<string, unknown> = {};
	for (const [key, spec] of Object.entries(actions)) {
		const value = source[key];
		if (value === undefined) {
			if (!spec.optional) throw new GatewayError(`${name}.${key}`, 'a required action is missing');
			continue;
		}
		bound[key] = bindAction(checkHandle(value, spec.names, `${name}.${key}`));
	}
	if (def.compose) {
		const composed = (def.compose as (d: unknown) => { props: Record<string, unknown>; children: JSXOutput })(safe);
		return { props: { ...composed.props, ...bound }, children: composed.children };
	}
	return { props: { ...(safe as object), ...bound }, children: undefined };
}

type AnyComponent = (props: any, key?: any, flags?: any) => JSXOutput;

/** A handle for a raw L2 component. */
export function gate<D extends Schema, A extends ActionMap = {}>(name: string, Raw: AnyComponent, def: GateDef<D, A>) {
	const anyDef = def as unknown as AnyGateDef;
	const handle = (props: object): JSXOutput => {
		const entry = enter(name, anyDef, props);
		return entry.children === undefined ? <Raw {...entry.props} /> : <Raw {...entry.props}>{entry.children}</Raw>;
	};
	return handle as unknown as (props: GateProps<D, A>) => JSXOutput;
}

/**
 * A handle for a brand slot. The slot is resolved at render time (a module-level lookup was undefined in a lazy client chunk, see
 * CheckoutOrderSummary). With no brand component it renders `Fallback` (an L1 component given the same validated props) or nothing.
 * The props are validated either way, so a default build exercises the same checks.
 */
export function slotGate<D extends Schema, A extends ActionMap = {}>(slot: SlotName, def: GateDef<D, A>, Fallback?: AnyComponent) {
	const anyDef = def as unknown as AnyGateDef;
	const handle = (props: object): JSXOutput => {
		const entry = enter(slot, anyDef, props);
		const View = (getSlot(slot) as AnyComponent | undefined) ?? Fallback;
		return View ? <View {...entry.props} /> : null;
	};
	return handle as unknown as (props: GateProps<D, A>) => JSXOutput;
}

/** A non-component presentation value (a stylesheet string) checked against its schema once. */
export const gateValue = <D extends Schema>(name: string, value: unknown, schema: D): Infer<D> => detach(schema, value, name);

/** Build-time presence of a brand view (a boolean, never the implementation): `export default hasView('route.home') ? Mount : Base`. */
export const hasView = (slot: SlotName): boolean => getSlot(slot) !== undefined;

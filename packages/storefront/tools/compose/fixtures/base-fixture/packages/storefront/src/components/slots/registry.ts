export interface SlotPropsMap { 'x.y': { a: number } }
export type SlotProps<K extends keyof SlotPropsMap> = SlotPropsMap[K];

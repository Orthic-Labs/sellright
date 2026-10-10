// expect-shape: orchestration-call
const getProductStockLevelsOnly = async (id: string) => id;

export const refreshStockLevels = () => getProductStockLevelsOnly('variant-1');

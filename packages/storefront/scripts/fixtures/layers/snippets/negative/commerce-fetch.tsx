// expect-shape: global-network
export const loadStock = () => fetch('/v1/shop/catalog/products?inStock=1').then((r) => r.json());

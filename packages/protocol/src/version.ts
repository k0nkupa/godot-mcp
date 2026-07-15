import product from "../product.json" with { type: "json" };

export const PRODUCT_VERSION = product.productVersion as "0.1.0";
export const BRIDGE_PROTOCOL_VERSION = product.bridgeProtocolVersion as "1.0";

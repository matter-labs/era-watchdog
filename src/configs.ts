import { MIN, SEC } from "./utils";

export const L2_EXECUTION_TIMEOUT = +(process.env.L2_EXECUTION_TIMEOUT ?? 15 * SEC);
export const SETTLEMENT_DEADLINE_SEC = +(process.env.SETTLEMENT_DEADLINE_SEC ?? 15 * MIN);

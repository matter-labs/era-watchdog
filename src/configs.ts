import { SEC } from "./utils";

export const L2_EXECUTION_TIMEOUT = +(process.env.L2_EXECUTION_TIMEOUT ?? 15 * SEC);

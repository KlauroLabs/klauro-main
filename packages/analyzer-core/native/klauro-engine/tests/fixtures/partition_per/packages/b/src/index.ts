import { shared } from "../../a/src/index";
export function useShared(): number { return shared() + 1; }

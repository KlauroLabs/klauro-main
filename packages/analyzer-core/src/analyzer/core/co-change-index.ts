export interface CoChangePartner {
  file: string;
  probability: number;
  support: number;
  lift: number;
}
export type CoChangeIndex = Record<string, CoChangePartner[]>;

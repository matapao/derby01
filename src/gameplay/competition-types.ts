/** Session championships and round facts. Names stay in this report; records contain numeric facts only. */
export interface PlayerRef {
  id: string;
  name: string;
}
export interface TeamDefinition {
  team: number;
  name: string;
  constructor: string;
}
export interface CompetitionCounters {
  shots: number;
  hits: number;
  topSpeedKmh: number;
  distanceM: number;
  survivalS: number;
  longestBurnS: number;
  jobs: number;
  repairs: number;
  fuel: number;
  precisionCorrect: number;
  precisionAttempts: number;
}
export interface ResultStats extends Omit<CompetitionCounters, 'precisionCorrect'> {
  points: number;
  accuracy: number | null;
  precision: number | null;
}
export interface TeamResult extends TeamDefinition, ResultStats {}
export interface PlayerResult extends PlayerRef, ResultStats {
  team: number;
}
export interface MechanicStanding {
  team: number;
  name: string;
  jobs: number;
  repairs: number;
  fuel: number;
  precision: number | null;
  precisionAttempts: number;
  points: number;
  totalPoints: number;
}
export interface ConstructorStanding {
  name: string;
  points: number;
  wins: number;
  rounds: number;
}
export interface RoundSummary {
  round: number;
  duration: number;
  teams: TeamResult[];
  players: PlayerResult[];
  mechanics: MechanicStanding[];
  constructors: ConstructorStanding[];
}
export interface CompetitionSample {
  team: number;
  alive: boolean;
  speedMps: number;
  burnS: number;
  driver: PlayerRef | null;
  occupants: readonly PlayerRef[];
}

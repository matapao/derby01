import type { GunState, VehicleState } from './model.ts';

export function isGunSeat(seat: number): seat is 1 | 2 {
  return seat === 1 || seat === 2;
}

export function gunKey(seat: number): 'hood' | 'trunk' {
  if (!isGunSeat(seat)) throw new Error(`Seat ${seat} has no gun`);
  return seat === 1 ? 'hood' : 'trunk';
}

export function gunAt(car: Pick<VehicleState, 'gun'>, seat: number): GunState {
  if (!isGunSeat(seat)) throw new Error(`Seat ${seat} has no gun`);
  return car.gun[seat];
}

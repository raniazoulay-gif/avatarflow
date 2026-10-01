import { useEffect, useState } from 'react';
import { controller } from './location';
import { type ControllerSnapshot } from './trip-controller';

export function useController(): ControllerSnapshot {
  const [snap, setSnap] = useState(controller.snapshot);
  useEffect(() => controller.subscribe(setSnap), []);
  return snap;
}

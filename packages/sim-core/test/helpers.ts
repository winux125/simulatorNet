import { createSimulationEngine, L2Switch, macFromIndex, Pc, type SimulationEngine } from "@sim/sim-core";

export interface StarLan {
  engine: SimulationEngine;
  sw: L2Switch;
  pcs: Pc[];
}

/**
 * Build `pcCount` PCs, each cabled to its own port on a single switch, all in
 * 192.168.1.0/24. PC k (0-based) gets 192.168.1.(10 + k) on port Gi0/(k+1).
 */
export function buildStarLan(pcCount: number, seed = 1): StarLan {
  const engine = createSimulationEngine({ seed });
  const sw = engine.add(new L2Switch("sw1", "Switch"));
  const pcs: Pc[] = [];

  for (let k = 0; k < pcCount; k++) {
    const pc = engine.add(new Pc(`pc${k + 1}`, `PC${k + 1}`));
    pc.addInterface("eth0", macFromIndex(k + 1));
    pc.configure({ ip: `192.168.1.${10 + k}`, mask: 24, gateway: "192.168.1.1" });

    const swPort = `Gi0/${k + 1}`;
    sw.addInterface(swPort, macFromIndex(100 + k));
    engine.connect(sw.id, swPort, pc.id, "eth0");

    pcs.push(pc);
  }

  return { engine, sw, pcs };
}

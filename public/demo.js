const names = ['Echo', 'Atlas', 'Nova', 'Volt', 'Orion', 'Kite', 'Pixel', 'Rook', 'Flint', 'Sable'];
const grenades = [
  { id: 'demo-smoke', type: 'smoke', x: .42, y: .54, effectTime: 12 },
  { id: 'demo-flash', type: 'flashbang', x: .61, y: .42, effectTime: null },
  { id: 'demo-molotov', type: 'molotov', x: .73, y: .62, effectTime: 5 },
];

export function demoState(map, bounds, time) {
  const point = (x, y) => ({
    x: bounds.minx + x * (bounds.maxx - bounds.minx),
    y: bounds.miny + y * (bounds.maxy - bounds.miny),
    z: null,
  });
  const players = names.map((name, index) => {
    const phase = time * .24 + index * 1.3;
    const ct = index < 5;
    return {
      id: `demo-${index}`, name, team: ct ? 'CT' : 'T', observerSlot: index,
      ...point((ct ? .29 : .66) + Math.cos(phase) * .13, .17 + (index % 5) * .15 + Math.sin(phase) * .065),
      hp: [82, 100, 45, 71, 30, 68, 100, 24, 53, 91][index], armor: 80 - index * 6,
      money: 4600 - index * 300, kills: 10 - index, deaths: index,
      weapons: [ct ? 'weapon_m4a1_silencer' : 'weapon_ak47'],
      ammo: 22 - index, angle: phase * 180 / Math.PI + 90,
      utility: [{ name: 'weapon_smokegrenade', count: 1 }],
      helmet: ct && index % 2 === 0, defuse: ct && index % 2 === 0,
    };
  });
  return {
    map, phase: 'live', round: 6, score: { ct: 4, t: 2 }, remaining: 94 - time % 94,
    player: players[0], roster: players, players, observer: true,
    grenades: grenades.map(grenade => ({ ...grenade, ...point(grenade.x, grenade.y) })),
    bomb: { state: 'dropped', ...point(.57, .37), remaining: null },
  };
}

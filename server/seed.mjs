// Load the three hand-drawn starter players into an empty database.
//
//   npm run seed
//
// Safe to re-run: players already present by slug are left alone.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { players } from './db.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = (slug) => fs.readFileSync(path.join(root, 'public/silhouettes', `${slug}.svg`), 'utf8');

const SEED = [
  {
    slug: 'cristiano-ronaldo',
    name: 'Cristiano Ronaldo',
    aliases: ['ronaldo', 'cr7', 'cristiano'],
    hints: [
      { label: 'Position', value: 'Forward' },
      { label: 'Nationality', value: 'Portugal' },
      { label: 'Era', value: '2002 - present' },
      { label: 'League', value: 'Premier League, La Liga, Serie A, Saudi Pro League' },
      { label: 'Best known at', value: 'Real Madrid & Manchester United' },
    ],
  },
  {
    slug: 'diego-maradona',
    name: 'Diego Maradona',
    aliases: ['maradona', 'diego', 'diego armando maradona'],
    hints: [
      { label: 'Position', value: 'Attacking midfielder' },
      { label: 'Nationality', value: 'Argentina' },
      { label: 'Era', value: '1976 - 1997' },
      { label: 'League', value: 'Serie A & La Liga' },
      { label: 'Best known at', value: 'Napoli' },
    ],
  },
  {
    slug: 'zinedine-zidane',
    name: 'Zinedine Zidane',
    aliases: ['zidane', 'zizou', 'zinedine'],
    hints: [
      { label: 'Position', value: 'Attacking midfielder' },
      { label: 'Nationality', value: 'France' },
      { label: 'Era', value: '1989 - 2006' },
      { label: 'League', value: 'Ligue 1, Serie A, La Liga' },
      { label: 'Best known at', value: 'Real Madrid & Juventus' },
    ],
  },
];

let added = 0;
for (const entry of SEED) {
  if (players.bySlug(entry.slug)) {
    console.log(`skip  ${entry.name} (already present)`);
    continue;
  }
  const player = players.create({ ...entry, silhouette: svg(entry.slug) });
  players.update(player.id, { status: 'ready' });
  console.log(`add   ${entry.name}`);
  added++;
}
console.log(`\n${added} player(s) added.`);

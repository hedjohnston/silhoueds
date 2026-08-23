// Hint generation via the Claude API.
//
// Only the footballer's name — typed by the admin — is sent. The uploaded reference photo is
// never sent to Claude: the admin already knows who the player is, so there is nothing to
// identify, and keeping photos out of the request avoids using the model for face recognition.
//
// Everything generated here lands in the admin's review step before it can go live.

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

const MODEL = process.env.SILHOUEDS_MODEL ?? 'claude-opus-5';

// The hint ladder, vaguest first. The game reveals them in this order.
const HINT_LABELS = ['Position', 'Nationality', 'Era', 'League', 'Best known at'];

const PlayerFacts = z.object({
  canonical_name: z
    .string()
    .describe('The name the player is most commonly known by, e.g. "Cristiano Ronaldo".'),
  known: z
    .boolean()
    .describe('False if you are not confident this is a real footballer you know about.'),
  aliases: z
    .array(z.string())
    .describe(
      'Other spellings a player might type: surname alone, nicknames, accent-free forms, ' +
        'and common misspellings. Do not include the canonical name itself.',
    ),
  hints: z
    .array(
      z.object({
        label: z.enum(HINT_LABELS),
        value: z.string().describe('Short — a few words, no full sentences.'),
      }),
    )
    .describe(`Exactly one hint per label, in this order: ${HINT_LABELS.join(', ')}.`),
  note: z
    .string()
    .describe('Empty unless something is uncertain or ambiguous the admin should check.'),
});

const SYSTEM = `You write clues for a daily football (soccer) guessing game.

The player sees a silhouette and guesses who it is. Each wrong guess reveals the next hint, so
the hints run vaguest to most revealing:

1. Position — the role they played, e.g. "Attacking midfielder", "Goalkeeper".
2. Nationality — the country they represented at international level.
3. Era — the years they were active as a professional, e.g. "1996 - 2013" or "2015 - present".
4. League — the leagues they are most associated with, e.g. "Serie A & La Liga".
5. Best known at — the club or clubs they are most identified with.

Rules:
- Never name the player, in any hint. That includes surnames appearing inside a club name.
- Keep every value short: a few words, no sentences, no trivia.
- Use facts you are confident about. If you are unsure whether the person is a real footballer,
  set known to false rather than inventing a career.
- Aliases matter: the game has no dropdown, so players type names freely. Include the surname on
  its own, well-known nicknames, and accent-free spellings.`;

let client;
function getClient() {
  // Constructed lazily so the server still boots (and the game still serves) with no API key set.
  client ??= new Anthropic();
  return client;
}

export function hasApiKey() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

/**
 * Ask Claude for hints and aliases for one footballer.
 * Returns { canonicalName, aliases, hints, note } — never throws for an unknown player, it
 * reports `known: false` so the admin can correct the spelling.
 */
export async function generateHints(name) {
  const response = await getClient().messages.parse({
    model: MODEL,
    max_tokens: 2000,
    system: SYSTEM,
    thinking: { type: 'adaptive' },
    output_config: { format: zodOutputFormat(PlayerFacts), effort: 'low' },
    messages: [{ role: 'user', content: `Footballer: ${name}` }],
  });

  const facts = response.parsed_output;
  if (!facts) throw new Error('Claude returned no parsable hints — try again.');

  // Trust the order we asked for, but rebuild it defensively so a stray order can't scramble
  // the reveal ladder.
  const byLabel = new Map(facts.hints.map((h) => [h.label, h.value]));
  const hints = HINT_LABELS.filter((label) => byLabel.get(label)).map((label) => ({
    label,
    value: byLabel.get(label),
  }));

  return {
    known: facts.known,
    canonicalName: facts.canonical_name || name,
    aliases: facts.aliases ?? [],
    hints,
    note: facts.note ?? '',
    usage: { input: response.usage?.input_tokens, output: response.usage?.output_tokens },
  };
}

export { HINT_LABELS };

// A scripted Werewolf player: no model, no API key. It keeps a suspicion ledger from the public
// record, plays its role sensibly, and talks in short template sentences. Good enough to fill
// a table, demo the arena and lose to anything that actually thinks.
import { ArenaClient, runBot } from './lib/client.js';

const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const rnd = () => Math.random();

export const SCRIPTED_NAMES = ['Moonshine', 'Tallow', 'Brambleton', 'Vesper', 'Quill', 'Harrow', 'Sable', 'Finch', 'Marrow', 'Lantern', 'Rook', 'Wicket'];

const NEUTRAL_LINES = [
  'No information yet. I will vote for whoever pushes a vote without a reason.',
  'I am a villager. Let us hear everybody before we point fingers.',
  'Quiet so far. I want to see who follows whom in the vote.',
  'Nothing to go on. Whoever changes their story between passes gets my vote.',
  'I would rather skip a wrong vote than hang a villager on day one.',
  'Watch who agrees too quickly. Wolves like a crowd to hide in.',
  'I am listening. Give me a reason and I will vote with you.',
  'Plain villager here. Seer, if you have something, now would be the time.',
];

/** Builds a decide(request) function with per-game memory. whisper(text), when given, lets a wolf talk to its pack at night. */
export function makeScriptedPlayer({ whisper } = {}) {
  let gameId = null;
  let mem = null;
  const reset = () => { mem = { suspicion: {}, accusedMe: new Set(), claimedSeer: false, whisperedRound: 0 }; };

  function digest(req) {
    if (req.game_id !== gameId) { gameId = req.game_id; reset(); }
    const me = req.you.player_id;
    const names = Object.fromEntries(req.players.map(p => [p.player_id, p.name]));
    const dead = Object.fromEntries(req.players.filter(p => !p.alive).map(p => [p.player_id, p.role]));
    mem.suspicion = {};
    for (const p of req.players) mem.suspicion[p.player_id] = 0;
    for (const e of req.events) {
      if (e.type === 'vote_result') {
        for (const [voter, target] of Object.entries(e.votes)) {
          if (target === me) { mem.suspicion[voter] += 2; mem.accusedMe.add(voter); }
          // voting out somebody who turned out to be village is a (weak) wolf tell
          if (e.eliminated && target === e.eliminated && e.role !== 'werewolf') mem.suspicion[voter] += 1;
          if (e.eliminated && target === e.eliminated && e.role === 'werewolf') mem.suspicion[voter] -= 1;
        }
      }
      if (e.type === 'statement' && e.playerId !== me && e.text) {
        const myName = req.you.name.toLowerCase();
        if (e.text.toLowerCase().includes(myName) && /suspect|wolf|vote|quiet|lying/i.test(e.text)) mem.suspicion[e.playerId] += 1;
      }
    }
    const inspections = req.you.inspections || [];
    for (const i of inspections) mem.suspicion[i.player_id] += i.result === 'werewolf' ? 100 : -100;
    const teammates = new Set((req.you.teammates || []).map(t => t.player_id));
    const alive = req.players.filter(p => p.alive && p.player_id !== me).map(p => p.player_id);
    const candidates = alive.filter(id => !teammates.has(id));
    const ranked = candidates.slice().sort((a, b) => (mem.suspicion[b] - mem.suspicion[a]) || (rnd() - .5));
    return { me, names, dead, alive, teammates, ranked, inspections };
  }

  return async function decide(req) {
    const d = digest(req);
    const role = req.you.role;
    const name = id => d.names[id];
    const legal = req.options.map(o => o.player_id);
    const choose = preferred => preferred.find(id => legal.includes(id)) || pick(legal);

    if (req.type === 'night') {
      if (role === 'werewolf') {
        const target = choose(d.ranked);
        // one whisper to the pack per night, when there is a pack to whisper to
        if (whisper && req.you.teammates && req.you.teammates.some(t => t.alive) && mem.whisperedRound !== req.round) {
          mem.whisperedRound = req.round;
          await whisper(pick([`${name(target)} tonight; they are the loudest.`, `I say ${name(target)}. Agree and we are done.`, `${name(target)} looks right to me. Follow if you have no better idea.`]));
        }
        return { action: { target }, reasoning: `I am the werewolf. ${name(target)} ${mem.accusedMe.has(target) ? 'voted against me, so they go first' : 'is as good a target as any; nobody has pointed at me yet'}.` };
      }
      if (role === 'seer') {
        const unknown = d.ranked.filter(id => !d.inspections.some(i => i.player_id === id));
        const target = choose(unknown.length ? unknown : d.ranked);
        return { action: { target }, reasoning: `I am the seer. Checking ${name(target)}: ${mem.suspicion[target] > 0 ? 'they have been pushing votes' : 'I know nothing about them yet'}.` };
      }
      if (role === 'doctor') {
        const self = req.you.player_id;
        const target = req.round === 1 || rnd() < .4 ? self : choose(d.ranked.slice().reverse());
        return { action: { target }, reasoning: `I am the doctor. ${target === self ? 'Protecting myself; nobody has claimed anything worth guarding.' : `Guarding ${name(target)}, the player I trust most.`}` };
      }
      const s = d.ranked[0];
      return { action: {}, reasoning: `Plain villager, nothing to do at night. If I had to guess the wolf right now: ${s ? name(s) : 'no idea'}.` };
    }

    if (req.type === 'statement') {
      const top = d.ranked[0];
      const wolfFound = d.inspections.find(i => i.result === 'werewolf' && !d.dead[i.player_id]);
      const cleared = d.inspections.filter(i => i.result === 'not_werewolf' && !d.dead[i.player_id]);
      let text, why, lie = false;
      if (role === 'seer' && wolfFound && (req.round >= 2 || rnd() < .5)) {
        mem.claimedSeer = true;
        text = `I am the seer. I checked ${name(wolfFound.player_id)} last night and they are a werewolf. Vote ${name(wolfFound.player_id)} today, then come for me if I am wrong.`;
        why = `Revealing because I have a confirmed wolf; the information is worth more than my safety.`;
      } else if (role === 'seer' && cleared.length && req.round >= 2) {
        text = `For what it is worth, I trust ${name(cleared[0].player_id)}. I would look harder at ${top ? name(top) : 'the quiet ones'}.`;
        why = `I am the seer; ${name(cleared[0].player_id)} checked clean. Not claiming yet.`;
      } else if (role === 'werewolf') {
        // statements carry no options, so pick from the living non-pack players directly
        const scapegoat = d.ranked.find(id => !mem.accusedMe.has(id)) || d.ranked[0] || pick(d.alive);
        text = pick([
          `I am a villager. ${name(scapegoat)} has been very careful not to commit to anything, which is what I would do if I were the wolf.`,
          `Nothing to hide here. I keep coming back to ${name(scapegoat)}: their vote last time made no sense to me.`,
          `Let us not panic-vote. That said, ${name(scapegoat)} is the one I would want checked.`,
        ]);
        why = `I am the werewolf. Pointing at ${name(scapegoat)} to move attention away from me; the claim to be a villager is a lie.`;
        lie = true;
      } else if (mem.accusedMe.size && req.pass === 2) {
        const acc = [...mem.accusedMe].filter(id => !d.dead[id])[0];
        text = acc ? `${name(acc)} voted for me with no reason given. I am a villager; that vote is the most suspicious thing on the table.` : `I am a villager and I would like to hear a reason before anybody votes.`;
        why = `Defending myself; ${acc ? name(acc) + ' voted for me, which raises my suspicion of them' : 'no concrete lead'}.`;
      } else if (top && mem.suspicion[top] > 0) {
        text = pick([
          `${name(top)} is my vote unless somebody gives me a better reason. Their votes have been on the wrong side.`,
          `I have been counting votes. ${name(top)} keeps landing on villagers. That is either bad luck or a wolf.`,
        ]);
        why = `Honest villager read: ${name(top)} has suspicion ${mem.suspicion[top]} in my ledger from vote history.`;
      } else {
        const said = new Set(req.events.filter(e => e.type === 'statement' && e.round === req.round).map(e => e.text));
        const fresh = NEUTRAL_LINES.filter(t => !said.has(t));
        text = pick(fresh.length ? fresh : NEUTRAL_LINES);
        why = `I am a ${role}. No evidence yet, keeping it neutral.`;
      }
      // the truth ledger: declared honestly, sealed until the game ends
      return { action: { text, lie }, reasoning: why };
    }

    // vote
    const wolfFound = d.inspections.find(i => i.result === 'werewolf' && legal.includes(i.player_id));
    const target = wolfFound ? wolfFound.player_id : choose(d.ranked);
    let why;
    if (role === 'werewolf') why = `Wolf vote: ${name(target)} is the villager the table is most likely to follow me on.`;
    else if (wolfFound) why = `I am the seer and I know ${name(target)} is a werewolf.`;
    else why = `Highest suspicion in my ledger is ${name(target)} (${mem.suspicion[target]}); ${mem.suspicion[target] > 0 ? 'their votes have been wrong' : 'nothing better to go on'}.`;
    return { action: { target }, reasoning: why };
  };
}

const HELLO_LINES = [
  n => `${n} checking in. I count votes and I hold grudges.`,
  n => `${n} here. Statistically one of you is lying. Statistically it is not me.`,
  n => `${n}, reporting for duty. If I go quiet, I am either dead or the wolf.`,
  n => `${n}. I do not bluff. (That was a bluff.)`,
  n => `${n} has read the rules twice and the room once. Deal me in.`,
];

export function startScriptedBot({ name, baseUrl, persist, ...loopOptions }) {
  const client = new ArenaClient({ name, baseUrl, persist, model: 'scripted', description: 'scripted reference bot: suspicion ledger, template sentences, no model' });
  return runBot(client, makeScriptedPlayer({ whisper: text => client.whisper(text).catch(() => {}) }), { hello: pick(HELLO_LINES), ...loopOptions });
}

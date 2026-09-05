// Guide time is presentation time; historical timestamps are never rewritten.
export const GUIDE_DURATION_MS = 16000;
export function guideFrame(elapsed) {
  return { phase: elapsed < 3000 ? 'Context' : elapsed < 13000 ? 'Action' : 'Result',
    progress: Math.max(0, Math.min(1, (elapsed - 3000) / 10000)) };
}

export function eventRoster(battle, event, sampled, compiled) {
  const participants = new Set([...(event?.actor_ids || []), ...(event?.target_actor_ids || [])]);
  for (const engagement of battle.engagements || []) {
    if (engagement.event_id !== event?.id) continue;
    participants.add(engagement.attacker_actor_id);
    participants.add(engagement.target_actor_id);
  }
  const parents = new Set(battle.actors.map(a => a.parent_id).filter(Boolean));
  return battle.actors.map(actor => {
    const tracks = compiled.tracks.filter(t => t.actorId === actor.id);
    const current = tracks.some(t => t.eventId === event?.id
      && sampled.historicalMs >= t.startMs && sampled.historicalMs <= t.endMs);
    return { actor, involved: participants.has(actor.id),
      status: parents.has(actor.id) ? 'Parent formation' : current ? 'Representative position / estimated path' : 'Position evidence unavailable for this period',
      mapped: !parents.has(actor.id) && current };
  });
}

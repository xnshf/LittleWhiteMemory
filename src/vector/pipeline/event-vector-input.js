export function buildEventVectorText(event) {
    return `${event?.title || ''} ${event?.summary || ''}`.trim();
}

export function selectMissingEventVectorPairs(events, vectors, fingerprint) {
    const inputs = new Map((events || []).map(event => [event?.id, buildEventVectorText(event)]));
    const existingIds = new Set(vectors.filter(item => item?.fingerprint === fingerprint
        && (!item.inputText || item.inputText === inputs.get(item.eventId)))
        .map(item => item?.eventId).filter(Boolean));
    return (events || []).filter(event => event?.id && !existingIds.has(event.id))
        .map(event => ({ id: event.id, text: buildEventVectorText(event) })).filter(pair => pair.text);
}

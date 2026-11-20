// One source of truth for both Host and browser Remote descriptions.
export function remoteSpec(namespace, z, createTypertRemoteInfo) {
  // z.json() validates correctly but its parsed record strips __proto__ keys.
  // Preserve arbitrary user JSON as data after validation, including backups.
  const json = z.custom(value => z.json().safeParse(value).success, { message: 'Invalid JSON' });
  const codec = (type, schema, jsonSchema) => ({ mode: 'strict', typeSymbol: '@yunshu/' + namespace + '#' + type, create: () => schema, jsonSchema });
  const parameter = (name, schema, jsonSchema, extras = {}) => {
    const c = codec(name, schema, jsonSchema);
    if (extras.source === 'lookup') c.typeSymbol = '@deepseek-ai/dsh-session/types#SessionId';
    return { name, source: 'json', codec: c, strictCodec: c, ...extras };
  };
  return createTypertRemoteInfo({
    package: ({ yunshuMemory: '@yunshu/dsh-memory', yunshuVoice: '@yunshu/dsh-voice', yunshuPersona: '@yunshu/dsh-persona' })[namespace],
    methods: { [namespace + '/request']: {
      service: namespace, description: 'User-owned Yunshu plugin operation', invocation: { kind: 'direct' },
      parameters: [
        parameter('agent', z.string(), { type: 'string' }, { wire: 'agentId', source: 'lookup', lookup: 'agent' }),
        parameter('action', z.string(), { type: 'string' }),
        parameter('payload', json, {}),
      ],
      cancellation: { parameter: 'signal' },
      result: codec('result', json, {}),
      sourceLocation: { file: 'packages/shared/remote-spec.mjs', line: 1, column: 1 },
    } },
  }, z);
}

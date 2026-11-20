export function registerCwdCompatibility(ctx) {
  return ctx.on('system-prompt/assemble', async (_draft, context, next) => {
    const assembly = await next();
    if (Object.hasOwn(assembly.variables, 'cwd')) return assembly;
    const needed = assembly.sections.some(section =>
      ['deployment:persona-prefix', 'deployment:persona-suffix'].includes(section.name) &&
      section.interpolate !== false && section.text.includes('{{cwd}}'));
    if (!needed) return assembly;
    const session = context.agent?.session, directories = ctx.get('workingDirectory');
    if (!session || typeof directories?.get !== 'function') return assembly;
    const cwd = directories.get(session);
    if (typeof cwd !== 'string' || !cwd) return assembly;
    return { ...assembly, variables: { ...assembly.variables, cwd } };
  });
}

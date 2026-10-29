// The only supported daily development entry point. Reuse the existing persistent
// workspace so adopting this command never creates another set of business data.
process.argv.push('--postgres', '--dev');
await import('./review.mjs');

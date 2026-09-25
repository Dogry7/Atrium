import anthropic from './anthropic.js';
import openai from './openai.js';
import simulated from './simulated.js';

export const providers = { anthropic, openai, simulated };

export function getProvider(id) {
  return providers[id] || null;
}

export function describeProviders(settings) {
  return Object.values(providers).map((p) => ({
    id: p.id, name: p.name, defaultModel: p.defaultModel, suggestedModels: p.suggestedModels,
    configFields: p.configFields, configured: p.isConfigured(settings),
  }));
}

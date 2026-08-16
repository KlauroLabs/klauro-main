import { aiService } from '../../ai/ai-service';
import { buildGroundedDomainVocabulary, recoverAIDomainLabel } from '../../analyzer/core/ai-domain-recovery';
import { containsGenericImplementationMechanicFiller, mentionsDeclaredImplementationName, stripApplicationImplementationFillerSentences } from '../../analyzer/core/ai-product-narrative';

describe('AI product domain recovery', () => {
  it('keeps first-party nouns while removing framework and protocol pollution', () => {
    const vocabulary = buildGroundedDomainVocabulary({
      systemName: 'Analysis Truth Fixture',
      projectText: [],
      entityNames: ['User'],
      capabilityNames: ['Manage users'],
      coreConcepts: ['post', 'nestjs', 'react', 'auth', 'guard', 'user'],
      implementationNames: ['NestJS', 'React', '@nestjs/common'],
      isGenericToken: token => token === 'manage',
    });

    expect(vocabulary).toEqual(expect.arrayContaining(['user', 'users']));
    expect(vocabulary).not.toEqual(expect.arrayContaining(['post', 'nestjs', 'react', 'auth', 'guard', 'manage']));
  });

  it('does not discard an evidence-backed product noun because it resembles generic prose', () => {
    const vocabulary = buildGroundedDomainVocabulary({
      systemName: 'Migration Suite',
      projectText: [],
      entityNames: ['Legacy'],
      capabilityNames: ['Review legacy'],
      coreConcepts: [],
      implementationNames: [],
      isGenericToken: () => false,
    });

    expect(vocabulary).toEqual(expect.arrayContaining(['legacy']));
  });

  it('retries rejected labels and returns a validated AI-authored domain', async () => {
    const generate = jest.spyOn(aiService, 'generateComponentDescription')
      .mockResolvedValueOnce('{"domain":"user-post"}')
      .mockResolvedValueOnce('{"domain":"user-management"}');

    try {
      const result = await recoverAIDomainLabel({
        systemName: 'User Service',
        domainVocabulary: ['user'],
        capabilities: ['Manage users'],
        entities: ['User'],
        rejectedCandidates: [],
        readOnly: false,
        model: 'test-model',
        parseDomain: raw => JSON.parse(raw).domain,
        normalize: candidate => candidate,
        evaluate: label => ({ accepted: label === 'user-management' }),
      });

      expect(result.label).toBe('user-management');
      expect(result.rejections).toEqual([{ label: 'user-post', reason: 'failed-domain-quality-gate' }]);
      expect(generate).toHaveBeenCalledTimes(2);
    } finally {
      generate.mockRestore();
    }
  });
});

describe('AI product narrative implementation filtering', () => {
  it('detects and removes only implementation-shaped sentences', () => {
    const description = 'Operators create and retrieve user information. Creating a user returns the preserved record. Operators can retrieve a specific user by identifier. The system is built using NestJS and React.';

    expect(mentionsDeclaredImplementationName(description, ['NestJS', 'React'])).toBe(true);
    expect(containsGenericImplementationMechanicFiller('The system runs on a server and interacts with a database.')).toBe(true);
    expect(containsGenericImplementationMechanicFiller('The system includes an authentication guard to control access.')).toBe(true);
    expect(stripApplicationImplementationFillerSentences(description, ['NestJS', 'React']))
      .toBe('Operators create and retrieve user information. Creating a user returns the preserved record. Operators can retrieve a specific user by identifier.');
  });
});

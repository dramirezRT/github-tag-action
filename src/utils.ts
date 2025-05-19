import * as core from '@actions/core';
import { prerelease, rcompare, SemVer, valid } from 'semver';
// @ts-ignore
import DEFAULT_RELEASE_TYPES from '@semantic-release/commit-analyzer/lib/default-release-types';
import { compareCommits, listTags, Tag } from './github';
import { defaultChangelogRules } from './defaults';
import { Await } from './ts';

type Tags = Await<ReturnType<typeof listTags>>;

export function convertVersionFormat(tag: string, customVersionFormat: false | string): string {
  if (!customVersionFormat) return tag;

  const regex = /^(.*?)(\d+)(?:\.(\d+))?(?:\.(\d+))?(.*)$/;
  const match = tag.match(regex);
  if (!match) return "";

  const [, prefix, major, minor = "0", patch = "0", suffix] = match;
  const versionMap = { MAJOR: major, MINOR: minor, PATCH: patch };

  const name = customVersionFormat.split('.').map(
    versionItem => versionMap[versionItem as keyof typeof versionMap] || ''
  ).join('.');
  return `${prefix}${name}${suffix}`;
}

export function removeDotFromPreReleaseIdentifier(
  tag: string,
  appendToPreReleaseTag: string,
  removeDot: 'remove' | 'add'
) {
  if (removeDot === 'add') {
    // If removeDot is false, need to add a dot to the identifier or leave it as is
    // if the identifier already has a dot
    // These tags can look like this: -rc.1, -rc2, -rc.3
    const regex = new RegExp(`(-${appendToPreReleaseTag})(\\w+)`);
    const match = tag.match(regex);
    if (match) {
      // If the identifier already has a dot, return the tag as is
      if (match[2].startsWith('.')) {
        return tag;
      }
      // If the identifier doesn't have a dot, add it
      return tag.replace(regex, `$1.$2`);
    }
  }
  // This regex matches a hyphen, then the identifier, then a dot, then any following characters
  // Example: -rc.1  => -rc1
  const regex = new RegExp(`(-${appendToPreReleaseTag})\\.(\\w+)`);
  return tag.replace(regex, `$1$2`);
}

export async function getValidTags(
  prefixRegex: RegExp,
  shouldFetchAllTags: boolean,
  isCustomVersionFormat: false | string
) {
  let tags: Tags = await listTags(shouldFetchAllTags);

  if (isCustomVersionFormat) {
    // Convert each tag to Semantic Version format
    // We need to revert the conversion when we are writing something back to the repository
    tags = tags.map((tag) => {
      const customTag = convertVersionFormat(tag.name, 'MAJOR.MINOR.PATCH');
      return { ...tag, name: customTag };
    });
  } 

  const invalidTags = tags.filter(
    (tag) =>
      !prefixRegex.test(tag.name) || !valid(tag.name.replace(prefixRegex, ''))
  );

  invalidTags.forEach((name) => core.debug(`Found Invalid Tag: ${name}.`));

  const validTags = tags
    .filter(
      (tag) =>
        prefixRegex.test(tag.name) && valid(tag.name.replace(prefixRegex, ''))
    )
    .sort((a, b) =>
      rcompare(a.name.replace(prefixRegex, ''), b.name.replace(prefixRegex, ''))
    );

  validTags.forEach((tag) => core.debug(`Found Valid Tag: ${tag.name}.`));

  return validTags;
}

export async function getCommits(
  baseRef: string,
  headRef: string
): Promise<{ message: string; hash: string | null }[]> {
  const commits = await compareCommits(baseRef, headRef);

  return commits
    .filter((commit) => !!commit.commit.message)
    .map((commit) => ({
      message: commit.commit.message,
      hash: commit.sha,
    }));
}

export function getBranchFromRef(ref: string) {
  return ref.replace('refs/heads/', '');
}

export function isPr(ref: string) {
  return ref.includes('refs/pull/');
}

export function getLatestTag(
  tags: Tags,
  prefixRegex: RegExp,
  tagPrefix: string
) {
  return (
    tags.find(
      (tag) =>
        prefixRegex.test(tag.name) &&
        !prerelease(tag.name.replace(prefixRegex, ''))
    ) || {
      name: `${tagPrefix}0.0.0`,
      commit: {
        sha: 'HEAD',
      },
    }
  );
}

export function getLatestPrereleaseTag(
  tags: Tags,
  identifier: string,
  prefixRegex: RegExp
) {
  return tags
    .filter((tag) => prerelease(tag.name.replace(prefixRegex, '')))
    .find((tag) => tag.name.replace(prefixRegex, '').match(identifier));
}

export function mapCustomReleaseRules(customReleaseTypes: string) {
  const releaseRuleSeparator = ',';
  const releaseTypeSeparator = ':';

  return customReleaseTypes
    .split(releaseRuleSeparator)
    .filter((customReleaseRule) => {
      const parts = customReleaseRule.split(releaseTypeSeparator);

      if (parts.length < 2) {
        core.warning(
          `${customReleaseRule} is not a valid custom release definition.`
        );
        return false;
      }

      const defaultRule = defaultChangelogRules[parts[0].toLowerCase()];
      if (customReleaseRule.length !== 3) {
        core.debug(
          `${customReleaseRule} doesn't mention the section for the changelog.`
        );
        core.debug(
          defaultRule
            ? `Default section (${defaultRule.section}) will be used instead.`
            : "The commits matching this rule won't be included in the changelog."
        );
      }

      if (!DEFAULT_RELEASE_TYPES.includes(parts[1])) {
        core.warning(`${parts[1]} is not a valid release type.`);
        return false;
      }

      return true;
    })
    .map((customReleaseRule) => {
      const [type, release, section] =
        customReleaseRule.split(releaseTypeSeparator);
      const defaultRule = defaultChangelogRules[type.toLowerCase()];

      return {
        type,
        release,
        section: section || defaultRule?.section,
      };
    });
}

export function mergeWithDefaultChangelogRules(
  mappedReleaseRules: ReturnType<typeof mapCustomReleaseRules> = []
) {
  const mergedRules = mappedReleaseRules.reduce(
    (acc, curr) => ({
      ...acc,
      [curr.type]: curr,
    }),
    { ...defaultChangelogRules }
  );

  return Object.values(mergedRules).filter((rule) => !!rule.section);
}

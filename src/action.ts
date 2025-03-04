import * as core from '@actions/core';
import { gte, inc, parse, ReleaseType, SemVer, valid } from 'semver';
import { analyzeCommits } from '@semantic-release/commit-analyzer';
import { generateNotes } from '@semantic-release/release-notes-generator';
import {
  getBranchFromRef,
  isPr,
  getCommits,
  getLatestPrereleaseTag,
  getLatestTag,
  getValidTags,
  mapCustomReleaseRules,
  mergeWithDefaultChangelogRules,
  convertVersionFormat
} from './utils';
import { createTag, Tag } from './github';
import { Await } from './ts';

export default async function main() {
  const defaultBump = core.getInput('default_bump') as ReleaseType | 'false';
  const defaultPreReleaseBump = core.getInput('default_prerelease_bump') as
    | ReleaseType
    | 'false';
  const tagPrefix = core.getInput('tag_prefix');
  const customTag = core.getInput('custom_tag');
  const releaseBranches = core.getInput('release_branches');
  const preReleaseBranches = core.getInput('pre_release_branches');
  const appendToPreReleaseTag = core.getInput('append_to_pre_release_tag');
  const createAnnotatedTag = /true/i.test(
    core.getInput('create_annotated_tag')
  );
  const dryRun = core.getInput('dry_run');
  const customReleaseRules = core.getInput('custom_release_rules');
  const shouldFetchAllTags = core.getInput('fetch_all_tags');
  const commitSha = core.getInput('commit_sha');
  const promotePatchToMinor = core.getInput('promote_patch_to_minor');
  const versionFormat = core.getInput('version_format');
  const isCustomVersionFormat = versionFormat !== "MAJOR.MINOR.PATCH";

  let mappedReleaseRules;
  if (customReleaseRules) {
    mappedReleaseRules = mapCustomReleaseRules(customReleaseRules);
  }

  const { GITHUB_REF, GITHUB_SHA } = process.env;

  if (!GITHUB_REF) {
    core.setFailed('Missing GITHUB_REF.');
    return;
  }

  const commitRef = commitSha || GITHUB_SHA;
  if (!commitRef) {
    core.setFailed('Missing commit_sha or GITHUB_SHA.');
    return;
  }

  const currentBranch = getBranchFromRef(GITHUB_REF);
  const isReleaseBranch = releaseBranches
    .split(',')
    .some((branch) => currentBranch.match(branch));
  const isPreReleaseBranch = preReleaseBranches
    .split(',')
    .some((branch) => currentBranch.match(branch));
  const isPullRequest = isPr(GITHUB_REF);
  const isPrerelease = !isReleaseBranch && !isPullRequest && isPreReleaseBranch;

  // Sanitize identifier according to
  // https://semver.org/#backusnaur-form-grammar-for-valid-semver-versions
  const identifier = (
    appendToPreReleaseTag ? appendToPreReleaseTag : currentBranch
  ).replace(/[^a-zA-Z0-9-]/g, '-');

  const prefixRegex = new RegExp(`^${tagPrefix}`);

  // Returns all matching tags in a SemVer compliant format
  // i.e. for versions (in repo) v1.2 -> v1.2.0 is returned if versionFormat is MAJOR.MINOR
  const validTags = await getValidTags(
    prefixRegex,
    /true/i.test(shouldFetchAllTags),
    versionFormat
  );
  const latestTag = getLatestTag(validTags, prefixRegex, tagPrefix);
  const latestPrereleaseTag = getLatestPrereleaseTag(
    validTags,
    identifier,
    prefixRegex
  );
  
  // validTags.forEach((tag: Tag) => {
  //   core.info(`Valid tag: ${tag.name}`);
  // });

  core.info(`Latest tag: ${latestTag ? latestTag.name : 'none'}`);
  core.info(
    `Latest pre-release tag: ${latestPrereleaseTag ? latestPrereleaseTag.name : 'none'}`
  );

  let commits: Await<ReturnType<typeof getCommits>>;

  let newVersion: string;

  if (customTag) {
    commits = await getCommits(latestTag.commit.sha, commitRef);

    core.setOutput('release_type', 'custom');
    newVersion = customTag;
  } else {
    let previousTag: ReturnType<typeof getLatestTag> | null;
    let previousVersion: SemVer | null;
    if (!latestPrereleaseTag) {
      previousTag = latestTag;
    } else if (isReleaseBranch) {
      previousTag = latestTag;
    }
    else {
      previousTag = gte(
        latestTag.name.replace(prefixRegex, ''),
        latestPrereleaseTag.name.replace(prefixRegex, '')
      )
        ? latestTag
        : latestPrereleaseTag;
    }

    if (!previousTag) {
      core.setFailed('Could not find previous tag.');
      return;
    }

    // Here we convert back the name of the tag to the original format
    // matching the versionFormat input
    // i.e. for versions v1.2.0 -> v1.2 is returned if versionFormat is MAJOR.MINOR
    // or for versions main-v1.2.0 -> main-v1.2 is returned if versionFormat is MAJOR.MINOR
    // for versions v1.2.3 -> v1.2.3 is returned if versionFormat is MAJOR.MINOR.PATCH (default)
    previousVersion = parse(previousTag.name.replace(prefixRegex, ''));
    previousTag.name = convertVersionFormat(previousTag.name, versionFormat);

    if (!previousVersion) {
      core.setFailed('Could not parse previous tag.');
      return;
    }

    core.info(
      `Previous tag was ${previousTag.name}, previous version was ${previousVersion.version}.`
    );
    core.setOutput('previous_version', previousVersion.version);
    core.setOutput('previous_tag', previousTag.name);

    commits = await getCommits(previousTag.commit.sha, commitRef);

    let bump = await analyzeCommits(
      {
        releaseRules: mappedReleaseRules
          ? // analyzeCommits doesn't appreciate rules with a section /shrug
            mappedReleaseRules.map(({ section, ...rest }) => ({ ...rest }))
          : undefined,
      },
      { commits, logger: { log: console.info.bind(console) } }
    );

    // Determine if we should continue with tag creation based on main vs prerelease branch
    let shouldContinue = true;
    if (isPrerelease) {
      if (!bump && defaultPreReleaseBump === 'false') {
        shouldContinue = false;
      }
    } else {
      if (!bump && defaultBump === 'false') {
        shouldContinue = false;
      }
    }

    // Default bump is set to false and we did not find an automatic bump
    if (!shouldContinue) {
      core.debug(
        'No commit specifies the version bump. Skipping the tag creation.'
      );
      return;
    }

    // If we don't have an automatic bump for the prerelease, just set our bump as the default
    if (isPrerelease && !bump) {
      bump = defaultPreReleaseBump;
    }

    core.info(`Detected bump is ${bump}.`);

    const patchReg = /patch$/;
    if (promotePatchToMinor && patchReg.test(bump)) {
      bump = bump.replace(patchReg, 'minor');
    }

    let releaseType: ReleaseType;

    if (!isPrerelease) {
      // If we are not on a prerelease branch and we did not find an automatic bump
      // we should use the default bump. If the default bump is lower than the
      // automatic bump we should use the default bump.
      const bumpPriority = ['patch', 'minor', 'major'];
      releaseType = bumpPriority.indexOf(defaultBump) > bumpPriority.indexOf(bump) ? defaultBump : bump;
    } else {
      // If the defaultPreReleaseBump is not prerelease, we need to check the bump priorities
      // to bump accordingly. Also if the previous version is not a prerelease version, we need to
      // bump the pre (major, minor or patch) version .i.e. 1.2.3 -> (prepatch) 1.2.4-RC.0
      // or 4.5.6 -> (preminor) 4.6.0-RC.0
      if (defaultPreReleaseBump !== 'prerelease' || !previousVersion.prerelease.length){
        bump = `pre${bump}`;
        const bumpPriority = ['prerelease', 'prepatch', 'preminor', 'premajor'];
        releaseType = bumpPriority.indexOf(defaultPreReleaseBump) > bumpPriority.indexOf(bump) ? defaultPreReleaseBump : bump;  
      } else {
        // If the previous version is a prerelease version, we should bump the prerelease version
        // since we are on a prerelease branch. i.e. 1.2.3-RC.0 -> (prerelease) 1.2.3-RC.1
        releaseType = defaultPreReleaseBump;
      }
    }
    
    core.info(`Release type is ${releaseType}.`);
    core.setOutput('release_type', releaseType);

    const incrementedVersion = inc(previousVersion, releaseType, identifier);

    if (!incrementedVersion) {
      core.setFailed('Could not increment version.');
      return;
    }

    if (!valid(incrementedVersion)) {
      core.setFailed(`${incrementedVersion} is not a valid semver.`);
      return;
    }

    newVersion = incrementedVersion;
  }

  newVersion = convertVersionFormat(newVersion, versionFormat);
  const newTag = convertVersionFormat(`${tagPrefix}${newVersion}`, versionFormat);

  core.info(`New version is ${newVersion}, new tag is ${newTag}.`);
  if (isCustomVersionFormat) {
    core.info(`\tWith custom version format: ${versionFormat}`);
  }

  core.setOutput('new_version', newVersion);
  core.setOutput('new_tag', newTag);

  const changelog = await generateNotes(
    {
      preset: 'conventionalcommits',
      presetConfig: {
        types: mergeWithDefaultChangelogRules(mappedReleaseRules),
      },
    },
    {
      commits,
      logger: { log: console.info.bind(console) },
      options: {
        repositoryUrl: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}`,
      },
      lastRelease: { gitTag: latestTag.name },
      nextRelease: { gitTag: newTag, version: newVersion },
    }
  );
  core.info(`Changelog is ${changelog}.`);
  core.setOutput('changelog', changelog);

  if (!isReleaseBranch && !isPreReleaseBranch) {
    core.info(
      'This branch is neither a release nor a pre-release branch. Skipping the tag creation.'
    );
    return;
  }

  if (validTags.map((tag) => tag.name).includes(newTag)) {
    core.info('This tag already exists. Skipping the tag creation.');
    return;
  }

  if (/true/i.test(dryRun)) {
    core.info('Dry run: not performing tag action.');
    return;
  }

  await createTag(newTag, createAnnotatedTag, commitRef);
}

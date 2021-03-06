const crypto = require('crypto');
const config = require('../config');
const debug = require('debug')('handlers:hook');
const Octokit = require('@octokit/rest');
const _ = require('lodash');
const octokit = new Octokit({
  auth:     `token ${config.secret.github.tokenBot}`,
  //log: console,
  previews: ['hellcat-preview', 'mercy-preview'], // enables nested teams API
});
// chinese bot: https://github.com/fanyijihua/robot

async function removeLabel(issue, params) {
  let hasLabel = issue.labels.some(label => label.name === params.name);
  if (!hasLabel) return;

  return await octokit.issues.removeLabel({
    owner:        config.org,
    issue_number: issue.number,
    ...params
  });
}

async function addLabels(issue, params) {
  return await octokit.issues.addLabels({
    owner:        config.org,
    issue_number: issue.number,
    ...params
  });
}

exports.post = async function(ctx) {

  let signature = ctx.get('x-hub-signature');
  let event = ctx.get('x-github-event');
  let id = ctx.get('x-github-delivery');

  if (!signature) {
    ctx.throw(400, 'No X-Hub-Signature found on request');
  }

  if (!event) {
    ctx.throw(400, 'No X-Github-Event found on request');
  }

  if (!id) {
    ctx.throw(400, 'No X-Github-Delivery found on request');
  }

  //debug("github hook", ctx.request);


  // koa-bodyparser gives that
  debug(ctx.request.rawBody);

  signature = signature.replace(/^sha1=/, '');
  let computedSignature = crypto
    .createHmac('sha1', Buffer.from(config.secret.github.hook, 'utf-8'))
    .update(ctx.request.rawBody)
    .digest('hex');

  debug("Hook data", event, ctx.request.body);

  debug("Compare signature", computedSignature, signature);

  if (computedSignature !== signature) {
    ctx.throw(400, 'X-Hub-Signature does not match blob signature');
  }

  let action = ctx.request.body.action;

  // new pr
  if (event === 'pull_request' && action === 'opened') {
    await onPullOpen(ctx.request.body);
  }

  // changes requested
  if (event === 'pull_request_review' && action === 'submitted') {
    await onPullRequestReviewSubmit(ctx.request.body);
  }

  // /done
  if (event === 'issue_comment' && action === 'created') {
    await onIssueComment(ctx.request.body);
  }

  ctx.body = '';

};

async function onIssueComment({issue, repository, comment}) {
  debug("Comment to Issue");

  if (!issue.pull_request) {
    return; // comment to issue, not to PR?
  }

  debug("Comment to PR");

  let labels = _.keyBy(issue.labels, 'name');

  if (comment.body.trim() === '/done') {
    await removeLabel(issue,{
      repo:         repository.name,
      name:         'changes requested',
    });

    await addLabels(issue,{
      repo:   repository.name,
      labels: ['review needed'],
    });

    debug("create review request");

    await octokit.pulls.createReviewRequest({
      owner: config.org,
      repo: repository.name,
      pull_number: issue.number,
      team_reviewers: 'translate-' + repository.name.split('.')[0]
    });

  }
}

async function onPullOpen({repository, pull_request}) {
  debug("PR open");

  await addLabels(pull_request,{
    repo:   repository.name,
    labels: ['review needed'],
  });

  await octokit.pulls.createReviewRequest({
    owner: config.org,
    repo: repository.name,
    pull_number: pull_request.number,
    team_reviewers: 'translate-' + repository.name.split('.')[0]
  });
}

async function onPullRequestReviewSubmit({repository, review, pull_request}) {

  debug("PR request submitted", review.state, pull_request.number);

  let labels = _.keyBy(pull_request.labels, 'name');

  if (review.state === "changes_requested") {
    await removeLabel(pull_request,{
      repo:         repository.name,
      name:         'review needed',
    });

    await addLabels(pull_request,{
      repo:   repository.name,
      labels: ['changes requested'],
    });

    await octokit.issues.createComment({
      owner: config.org,
      repo: repository.name,
      issue_number: pull_request.number,
      body: `Please make the requested changes. After it, add a comment "/done".  \nThen I'll ask for a new review :ghost:`
    });

  }

  if (review.state === "approved") {
    await removeLabel(pull_request,{
      repo:         repository.name,
      name:         'changes requested',
    });

    debug("Labels", labels);

    if (!labels['needs +1']) {
      await removeLabel(pull_request,{
        repo:         repository.name,
        name:         'review needed'
      });
      await addLabels(pull_request,{
        repo:   repository.name,
        labels: ['needs +1'],
      });

      await octokit.pulls.createReviewRequest({
        owner: config.org,
        repo: repository.name,
        pull_number: pull_request.number,
        team_reviewers: 'translate-' + repository.name.split('.')[0]
      });

    } else {
      // maybe just merge on 2nd approval, so this never happens
      await removeLabel(pull_request,{
        repo:         repository.name,
        name:         'needs +1'
      });
      await addLabels(pull_request,{
        repo:   repository.name,
        labels: ['ready to merge']
      });
    }
  }

}


/**
 1) каждый PR помечается review needed
 2) когда ревьювер request changes, PR помечается changes requested
 3) когда чел вносит изменения, он пишет /done, и PR помечается review needed
 4) когда изменения приняты (changes approved) PR помечается +1 review needed
 5) то же самое еще раз для второго review (edited)
 */

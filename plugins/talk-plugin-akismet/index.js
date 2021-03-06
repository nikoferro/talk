const debug = require('debug')('talk:plugin:akismet');
const { ErrSpam } = require('./errors');
const akismet = require('akismet-api');
const { get, merge } = require('lodash');
const { KEY, SITE } = require('./config');
const client = akismet.client({
  key: KEY,
  blog: SITE,
});

let enabled = true;

// TODO: when using a developer key, this is possible, the plus plan does not
// allow us to check the key.
// let enabled = false;
// client.verifyKey((err, valid) => {
//   if (err) {
//     throw err;
//   }

//   if (valid) {
//     enabled = true;
//   } else {
//     throw new Error('Akismet key is invalid');
//   }
// });

module.exports = {
  typeDefs: `
  input CreateCommentInput {

    # If true, the mutation will fail when the
    # body contains detected spam.
    checkSpam: Boolean
  }

  type Comment {
    spam: Boolean
  }
  `,
  hooks: {
    RootMutation: {
      createComment: {
        async pre(_, { input }, { loaders, parent: req }) {
          // If the key validation failed, then we can't run with the client.
          if (!enabled) {
            debug('not enabled, passing');
            return;
          }

          let spam = false;
          try {
            const user_ip = get(req, 'ip', false);
            if (!user_ip) {
              debug('no ip on request');
              return;
            }

            // Get some headers from the request.
            const user_agent = req.get('User-Agent');
            if (!user_agent || user_agent.length === 0) {
              debug('no user agent on request');
              return;
            }

            const referrer = req.get('Referrer');
            if (!referrer || referrer.length === 0) {
              debug('no referrer on request');
              return;
            }

            // Get the Asset that the comment is being made against.
            const asset = await loaders.Assets.getByID.load(input.asset_id);
            if (!asset) {
              debug('asset not found for new comment');
              return;
            }

            // Send off the comment to Akismet to check to see what they say.
            spam = await client.checkSpam({
              user_ip,
              user_agent,
              referrer,
              permalink: asset.url,
              comment_type: 'comment',
              comment_content: input.body,
              is_test: true,
            });

            debug(`comment analyzed as ${spam ? 'being' : 'not being'} spam`);
          } catch (err) {
            console.trace(err);
            return;
          }

          // Attach scores to metadata.
          input.metadata = merge({}, input.metadata || {}, {
            akismet: spam,
          });

          if (spam) {
            if (input.checkSpam) {
              throw ErrSpam;
            }

            // Attach reason information for the flag being added.
            input.status = 'SYSTEM_WITHHELD';
            input.actions =
              input.actions && input.actions.length >= 0 ? input.actions : [];
            input.actions.push({
              action_type: 'FLAG',
              user_id: null,
              group_id: 'SPAM_COMMENT',
              metadata: {},
            });
          }
        },
      },
    },
  },
  resolvers: {
    Comment: {
      spam: comment => get(comment, 'metadata.akismet', null),
    },
  },
};

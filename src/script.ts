import {PublishMessageOptions, script} from '@digshare/script';

import puppeteer from 'puppeteer-core';
import {getChromeWebSocketDebuggerURL} from './chrome';

const SEARCH_KEYWORD = '(#NFT) (discord.gg OR t.me OR discord.com)';

const MAX_TWEETS_TO_FETCH = 100;
const MAX_FETCH_TIMES = 20;

const TAGS: {
  minFollowers: number;
  tag: string;
}[] = [
  {minFollowers: 50000, tag: '50K+'},
  {minFollowers: 100000, tag: '100K+'},
  {minFollowers: 200000, tag: '200K+'},
  {minFollowers: 500000, tag: '500K+'},
  {minFollowers: 1000000, tag: '1M+'},
];

interface Payload {
  dev: boolean | undefined;
}

interface Storage {
  lastTweetId: number | undefined;
}

export default script<Payload, Storage>(
  async (payload, {storage, api, dryRun}) => {
    let chromeWSURL = await getChromeWebSocketDebuggerURL(!!payload?.dev);

    const browser = await puppeteer.connect({
      browserWSEndpoint: chromeWSURL,
    });

    const twitterSearchURL = new URL('https://twitter.com/search');

    twitterSearchURL.searchParams.set('q', SEARCH_KEYWORD);
    twitterSearchURL.searchParams.set('src', 'typed_query');
    twitterSearchURL.searchParams.set('f', 'live');

    const searchResultPathname = '/i/api/2/search/adaptive.json';

    let page = await browser.newPage();

    try {
      let urlAndHeadersPromise = new Promise<{
        searchAPIURL: URL;
        headers: Record<string, string> | undefined;
        result: TwitterAdaptiveResult | undefined;
      }>(resolve =>
        page.on('requestfinished', async request => {
          let url = new URL(request.url());

          if (url.pathname === searchResultPathname) {
            let response = request.response();

            let result = (await response?.json()) as
              | TwitterAdaptiveResult
              | undefined;

            resolve({
              searchAPIURL: url,
              headers: request?.headers(),
              result,
            });
          }
        }),
      );

      await page.goto(twitterSearchURL.href);

      await page.waitForResponse(request => {
        let url = request.url();
        let urlObj = new URL(url);

        return urlObj.pathname === searchResultPathname;
      });

      let {searchAPIURL, headers, result} = await urlAndHeadersPromise;

      let tweets = Object.values(result?.globalObjects.tweets ?? []);
      let userMap = new Map(Object.entries(result?.globalObjects.users ?? {}));

      let lastTweetId = storage.getItem('lastTweetId');

      console.info('[twitter-nft]', 'lastTweetId', lastTweetId);

      let recentTweetId = Math.max(...tweets.map(tweet => tweet.id));

      if (recentTweetId !== -Infinity) {
        storage.setItem('lastTweetId', recentTweetId);
      }

      let tweetsAvailable: TwitterAdaptiveResult['globalObjects']['tweets'][string][] =
        [];

      let fetchedTimes = 1;
      let tweetsCountFetched = 0;

      while (true) {
        console.info('[twitter-nft]', 'fetchedMoreTweets', tweets.length);

        if (recentTweetId === -Infinity) {
          recentTweetId = Math.max(...tweets.map(tweet => tweet.id));

          if (recentTweetId !== -Infinity) {
            storage.setItem('lastTweetId', recentTweetId);
          }
        }

        let newTweetsAvailable = lastTweetId
          ? tweets.filter(tweet => tweet.id > lastTweetId!)
          : tweets;

        if (
          newTweetsAvailable.length < tweets.length ||
          tweetsCountFetched >= MAX_TWEETS_TO_FETCH ||
          fetchedTimes >= MAX_FETCH_TIMES
        ) {
          break;
        }

        tweetsAvailable.push(...newTweetsAvailable);

        let nextResultCursor = result?.timeline.instructions
          .flatMap(instruction =>
            'addEntries' in instruction
              ? instruction.addEntries.entries
              : 'replaceEntry' in instruction
              ? [instruction.replaceEntry.entry]
              : [],
          )
          .find(entry => entry.entryId === 'sq-cursor-bottom');

        if (!nextResultCursor) {
          break;
        }

        searchAPIURL.searchParams.set(
          'cursor',
          nextResultCursor.content.operation.cursor.value,
        );

        result = await page.evaluate(
          async (url, headers) => {
            // @ts-ignore
            let response = await window.fetch(url, {
              headers,
            });

            return response.json();
          },
          searchAPIURL.href,
          headers ?? {},
        );

        tweets = Object.values(result?.globalObjects.tweets ?? []);

        tweetsCountFetched += tweets.length;
        fetchedTimes += 1;

        for (let [id, user] of Object.entries(
          result?.globalObjects.users ?? {},
        )) {
          userMap.set(id, user);
        }

        if (!tweets) {
          break;
        }
      }

      let tweetsToSend = filterAndTagGroupTweets(tweetsAvailable, userMap);

      console.info(
        '[twitter-nft]',
        `Fetched tweets: ${tweetsAvailable.length}, filtered: ${tweetsToSend.length}`,
      );

      for (let tweet of tweetsToSend) {
        let message = await convertTweetToMessageContent(tweet, page);

        api.publishMessage(message);
      }
    } catch (error) {
      console.error(error);
      page.close();
    }
  },
);

function filterAndTagGroupTweets(
  tweets: TwitterAdaptiveResult['globalObjects']['tweets'][string][],
  userMap: Map<string, TwitterAdaptiveResult['globalObjects']['users'][string]>,
) {
  return tweets
    .map(tweet => {
      let user = userMap.get(tweet.user_id_str);

      if (!user) {
        return;
      }

      let tags = TAGS.filter(
        tag => user!.followers_count >= tag.minFollowers,
      ).map(tag => tag.tag);

      return {
        tweet,
        user,
        tags,
      };
    })
    .filter(
      (
        tweet,
      ): tweet is {
        tweet: TwitterAdaptiveResult['globalObjects']['tweets'][string];
        user: TwitterAdaptiveResult['globalObjects']['users'][string];
        tags: string[];
      } => !!tweet && !!tweet.tags.length,
    );
}

async function convertTweetToMessageContent(
  tweet: {
    tweet: TwitterAdaptiveResult['globalObjects']['tweets'][string];
    user: TwitterAdaptiveResult['globalObjects']['users'][string];
    tags: string[];
  },
  page: puppeteer.Page,
): Promise<PublishMessageOptions> {
  let imageURL = tweet.tweet.entities.media?.find(
    media => media.type === 'photo',
  )?.media_url_https;

  let image: Buffer | undefined;

  if (imageURL) {
    // TODO: Fetch image
  }

  return {
    content:
      `👨🏿‍💻 ${tweet.user.name} (@${tweet.user.screen_name}, 👥 ${tweet.user.followers_count})\n\n` +
      ` ${tweet.tweet.full_text}`,
    links: [
      {
        url: `https://twitter.com/${tweet.user.screen_name}/status/${tweet.tweet.id_str}`,
        description: 'Tweet',
      },
      ...tweet.tweet.entities.urls.map(url => {
        return {
          url: url.expanded_url,
          description: url.display_url,
        };
      }),
    ],
    tags: tweet.tags,
    images: image ? [image] : undefined,
  };
}

interface TwitterAdaptiveResult {
  globalObjects: {
    tweets: {
      [TId: string]: {
        created_at: string;
        id: number;
        id_str: string;
        full_text: string;
        truncated: boolean;
        display_text_range: [number, number];
        entities: {
          hashtags: {text: string; indices: [number, number]}[];
          symbols: [];
          user_mentions: {
            screen_name: string;
            name: string;
            id: number;
            id_str: string;
            indices: [number, number];
          }[];
          urls: {
            url: string;
            expanded_url: string;
            display_url: string;
            indices: [number, number];
          }[];
          media: {
            id: number;
            id_str: string;
            indices: [number, number];
            media_url: string;
            media_url_https: string;
            url: string;
            display_url: string;
            expanded_url: string;
            type: 'photo';
            original_info: unknown;
            sizes: unknown;
          }[];
        };
        source: string;
        user_id: number;
        user_id_str: string;
        lang: string;
      };
    };
    users: {
      [TId in string]: {
        id: number;
        id_str: string;
        name: string;
        screen_name: string;
        location: string;
        description: string;
        url: string;
        entities: unknown;
        protected: boolean;
        followers_count: number;
        friends_count: number;
        created_at: string;
        favourites_count: number;
        utc_offset: null;
        time_zone: null;
        geo_enabled: false;
        verified: false;
        statuses_count: 154;
        media_count: 20;
        lang: null;
      };
    };
    moments: {};
    cards: {};
    places: {};
    media: {};
    broadcasts: {};
    topics: {};
    lists: {};
  };
  timeline: {
    id: string;
    instructions: (
      | {
          addEntries: {
            entries: (
              | {
                  entryId: 'sq-cursor-top';
                  sortIndex: '999999999';
                  content: {
                    operation: {
                      cursor: {
                        value: string;
                        cursorType: 'Top';
                      };
                    };
                  };
                }
              | {
                  entryId: 'sq-cursor-bottom';
                  sortIndex: '0';
                  content: {
                    operation: {
                      cursor: {
                        value: string;
                        cursorType: 'Bottom';
                      };
                    };
                  };
                }
            )[];
          };
        }
      | {
          replaceEntry: {
            entryIdToReplace: string;
            entry: {
              entryId: string;
              sortIndex: string;
              content: {
                operation: {
                  cursor: {
                    value: string;
                    cursorType: string;
                  };
                };
              };
            };
          };
        }
    )[];
  };
}

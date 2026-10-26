import { describe, expect, it } from 'vitest';
import {
    decodeHtmlEntities,
    isInstagramCdnUrl,
    parseInstagramEmbedPage,
} from '../../../src/services/instagramVideo/instagramEmbedPage';

/**
 * A page shaped like Instagram's embed page: the post data is a JSON string
 * (`contextJSON`) inside a JSON array inside a script, with `/` escaped the
 * way Instagram does it.
 */
function pageWithContext(context: unknown, mediaType = 'GraphVideo'): string {
    const literal = JSON.stringify(JSON.stringify(context)).replace(
        /\//g,
        '\\/'
    );
    return [
        '<!DOCTYPE html><html><head><script type="application/json">',
        '{"require":[["PolarisEmbedSimple","init",[],[{"isRichEmbed":true,',
        `"isSidecar":false,"contextJSON":${literal}}]],["Other","x",[],[]]]}`,
        '</script></head><body>',
        `<div class="Embed" data-media-type="${mediaType}">`,
        '<img class="EmbeddedMediaImage" src="https://instagram.fabc1-1.fna.fbcdn.net/poster.jpg">',
        '</div></body></html>',
    ].join('');
}

const VIDEO_URL =
    'https://instagram.fslc3-2.fna.fbcdn.net/o1/v/t2/f2/m86/AQO.mp4?_nc_ht=x&oh=1';
const AVATAR =
    'https://scontent.cdninstagram.com/v/t51.82787-19/601447735_n.jpg?stp=dst';

describe('parseInstagramEmbedPage', () => {
    it('reads a video post from contextJSON', () => {
        const post = parseInstagramEmbedPage(
            pageWithContext({
                context: {
                    type: 'GraphVideo',
                    shortcode: 'De7XCa_TJ4h',
                    copyright_blocked: false,
                },
                gql_data: {
                    shortcode_media: {
                        __typename: 'GraphVideo',
                        shortcode: 'De7XCa_TJ4h',
                        is_video: true,
                        display_url:
                            'https://instagram.fslc3-1.fna.fbcdn.net/poster.jpg',
                        dimensions: { height: 2160, width: 1215 },
                        video_duration: 61.508,
                        video_url: VIDEO_URL,
                        owner: {
                            username: 'nasaadmin',
                            profile_pic_url: AVATAR,
                            is_verified: true,
                        },
                        edge_media_to_caption: {
                            edges: [
                                {
                                    node: {
                                        text: 'This is how @nasa does game day. Roll Tide! 🚀🏈',
                                    },
                                },
                            ],
                        },
                    },
                },
            })
        );

        expect(post).toEqual({
            mediaType: 'GraphVideo',
            shortcode: 'De7XCa_TJ4h',
            username: 'nasaadmin',
            profilePicUrl: AVATAR,
            caption: 'This is how @nasa does game day. Roll Tide! 🚀🏈',
            copyrightBlocked: false,
            items: [{ kind: 'video', url: VIDEO_URL, durationSeconds: 61.508 }],
        });
    });

    it('reads every carousel child, images and videos, in order', () => {
        const post = parseInstagramEmbedPage(
            pageWithContext(
                {
                    context: {
                        type: 'GraphSidecar',
                        shortcode: 'De5mVMikVB-',
                        copyright_blocked: true,
                    },
                    gql_data: {
                        shortcode_media: {
                            __typename: 'GraphSidecar',
                            is_video: false,
                            display_url: 'https://a.fbcdn.net/cover.jpg',
                            owner: { username: 'nasaadmin' },
                            edge_media_to_caption: { edges: [] },
                            edge_sidecar_to_children: {
                                edges: [
                                    {
                                        node: {
                                            __typename: 'GraphImage',
                                            is_video: false,
                                            display_url:
                                                'https://a.fbcdn.net/1.jpg',
                                        },
                                    },
                                    {
                                        node: {
                                            __typename: 'GraphVideo',
                                            is_video: true,
                                            display_url:
                                                'https://a.fbcdn.net/2-poster.jpg',
                                            video_url:
                                                'https://a.fbcdn.net/2.mp4',
                                        },
                                    },
                                    {
                                        // A video without its URL is left out,
                                        // never replaced by its poster.
                                        node: {
                                            __typename: 'GraphVideo',
                                            is_video: true,
                                            display_url:
                                                'https://a.fbcdn.net/3-poster.jpg',
                                        },
                                    },
                                    {
                                        node: {
                                            is_video: false,
                                            display_url:
                                                'https://a.fbcdn.net/4.jpg',
                                        },
                                    },
                                ],
                            },
                        },
                    },
                },
                'GraphSidecar'
            )
        );

        expect(post!.mediaType).toBe('GraphSidecar');
        expect(post!.shortcode).toBe('De5mVMikVB-');
        expect(post!.copyrightBlocked).toBe(true);
        expect(post!.caption).toBeNull();
        expect(post!.profilePicUrl).toBeNull();
        expect(post!.items).toEqual([
            {
                kind: 'image',
                url: 'https://a.fbcdn.net/1.jpg',
                durationSeconds: null,
            },
            {
                kind: 'video',
                url: 'https://a.fbcdn.net/2.mp4',
                durationSeconds: null,
            },
            {
                kind: 'image',
                url: 'https://a.fbcdn.net/4.jpg',
                durationSeconds: null,
            },
        ]);
    });

    it('decodes escaped unicode, slashes and quotes in contextJSON', () => {
        // Written out by hand, the way the page encodes it: the outer string
        // escapes the inner JSON's quotes and backslashes.
        const inner =
            '{\\"context\\":{\\"type\\":\\"GraphImage\\"},\\"gql_data\\":{\\"shortcode_media\\":{' +
            '\\"__typename\\":\\"GraphImage\\",\\"is_video\\":false,' +
            '\\"display_url\\":\\"https:\\\\\\/\\\\\\/x.cdninstagram.com\\\\\\/a.jpg?a=1\\\\u0026b=2\\",' +
            '\\"owner\\":{\\"username\\":\\"caf\\\\u00e9\\"},' +
            '\\"edge_media_to_caption\\":{\\"edges\\":[{\\"node\\":{\\"text\\":' +
            '\\"say \\\\\\"hi\\\\\\" \\\\ud83d\\\\ude80\\\\nline 2 <\\\\/b>\\"}}]}}}}';
        const html = `<script>[{"contextJSON":"${inner}"},{"x":"\\""}]</script>`;

        const post = parseInstagramEmbedPage(html);

        expect(post!.username).toBe('café');
        expect(post!.caption).toBe('say "hi" 🚀\nline 2 </b>');
        expect(post!.items).toEqual([
            {
                kind: 'image',
                url: 'https://x.cdninstagram.com/a.jpg?a=1&b=2',
                durationSeconds: null,
            },
        ]);
    });

    it('falls back to the HTML for an image post with contextJSON null', () => {
        const html = [
            '<html><body><div class="Embed" data-media-type="GraphImage" data-media-id="1">',
            '<div class="Header"><div class="AvatarContainer">',
            '<a class="Avatar InsideRing" href="https://www.instagram.com/stories/nasa/">',
            '<img src="https://scontent.cdninstagram.com/v/avatar.jpg?a=1&amp;b=2" alt="nasa" /></a></div>',
            '<div class="HeaderText"><a class="Username" href="https://www.instagram.com/nasa/">',
            '<span class="UsernameText">nasa</span></a></div></div>',
            '<div class="EmbeddedMedia"><img class="EmbeddedMediaImage" alt="Instagram post shared by &#064;nasa" ',
            'src="https://instagram.fslc3-1.fna.fbcdn.net/v/t51/869_n.jpg?stp=dst-jpg&amp;_nc_cat=1&amp;oh=00_A" ',
            'srcset="https://instagram.fslc3-1.fna.fbcdn.net/v/small.jpg 640w" /></div>',
            '<div class="Caption"><a class="CaptionUsername" href="https://www.instagram.com/nasa/" ',
            'target="_blank">nasa</a><br /><br />A close-knit family of stars ✨<br /><br />',
            'Photo by <a href="/NASAHubble/">&#064;NASAHubble</a> &amp; friends, it&#039;s &quot;big&quot;.<br />',
            '<a href="/explore/tags/NASA/">#NASA</a>',
            '<div class="CaptionComments"><a class="CaptionCommentsExpand" href="https://www.instagram.com/p/X/">',
            'View all 546 comments</a></div></div>',
            '<div class="Footer"><a class="CommentInput">Add a comment...</a></div>',
            '</div><script>s.handle({"require":[["PolarisEmbedSimple","init",[],[{"isRichEmbed":false,',
            '"isSidecar":false,"contextJSON":null}]]]});</script></body></html>',
        ].join('');

        expect(parseInstagramEmbedPage(html)).toEqual({
            mediaType: 'GraphImage',
            shortcode: null,
            username: 'nasa',
            profilePicUrl:
                'https://scontent.cdninstagram.com/v/avatar.jpg?a=1&b=2',
            caption:
                'A close-knit family of stars ✨\n\nPhoto by @NASAHubble & friends, it\'s "big".\n#NASA',
            copyrightBlocked: false,
            items: [
                {
                    kind: 'image',
                    url: 'https://instagram.fslc3-1.fna.fbcdn.net/v/t51/869_n.jpg?stp=dst-jpg&_nc_cat=1&oh=00_A',
                    durationSeconds: null,
                },
            ],
        });
    });

    it('never takes the poster image of a video page without contextJSON', () => {
        const html =
            '<div class="Embed" data-media-type="GraphVideo"><span class="UsernameText">nasa</span>' +
            '<img class="EmbeddedMediaImage" src="https://a.fbcdn.net/poster.jpg"></div>' +
            '<script>[{"contextJSON":null}]</script>';
        const post = parseInstagramEmbedPage(html);
        expect(post!.mediaType).toBe('GraphVideo');
        expect(post!.username).toBe('nasa');
        expect(post!.caption).toBeNull();
        expect(post!.items).toEqual([]);
    });

    it('returns null for empty, garbage or non-embed pages', () => {
        expect(parseInstagramEmbedPage('')).toBeNull();
        expect(parseInstagramEmbedPage('not html at all')).toBeNull();
        expect(
            parseInstagramEmbedPage(
                '<html><body><h1>Log in to Instagram</h1></body></html>'
            )
        ).toBeNull();
        expect(
            parseInstagramEmbedPage('<script>[{"contextJSON":"{broken')
        ).toBeNull();
        expect(
            parseInstagramEmbedPage('<script>[{"contextJSON":"not json"}]')
        ).toBeNull();
        expect(
            parseInstagramEmbedPage(
                '<script>[{"contextJSON":"{\\"gql_data\\":{}}"}]</script>'
            )
        ).toBeNull();
        expect(
            parseInstagramEmbedPage(undefined as unknown as string)
        ).toBeNull();
    });
});

describe('isInstagramCdnUrl', () => {
    it('accepts https URLs on Instagram and Facebook CDN hosts', () => {
        expect(
            isInstagramCdnUrl('https://scontent.cdninstagram.com/v/a.jpg')
        ).toBe(true);
        expect(
            isInstagramCdnUrl(
                'https://instagram.fslc3-1.fna.fbcdn.net/v/a.mp4?x=1'
            )
        ).toBe(true);
        expect(isInstagramCdnUrl('https://SCONTENT.CDNINSTAGRAM.COM/a')).toBe(
            true
        );
    });

    it('rejects everything else', () => {
        for (const url of [
            'http://scontent.cdninstagram.com/a.jpg',
            'https://cdninstagram.com/a.jpg',
            'https://fbcdn.net/a.jpg',
            'https://evilfbcdn.net/a.jpg',
            'https://scontent.cdninstagram.com.evil.com/a.jpg',
            'https://user:pass@scontent.cdninstagram.com/a.jpg',
            'https://scontent.cdninstagram.com:8443/a.jpg',
            'https://www.instagram.com/p/ABC/',
            'file:///etc/passwd',
            'not a url',
            '',
        ]) {
            expect(isInstagramCdnUrl(url)).toBe(false);
        }
    });
});

describe('decodeHtmlEntities', () => {
    it('decodes named, decimal and hex entities', () => {
        expect(
            decodeHtmlEntities('&#064;nasa &amp; &lt;b&gt; &#x1F680; &quot;')
        ).toBe('@nasa & <b> 🚀 "');
    });

    it('leaves unknown or invalid entities alone', () => {
        expect(decodeHtmlEntities('&bogus; &#0; &#x110000;')).toBe(
            '&bogus; &#0; &#x110000;'
        );
    });
});

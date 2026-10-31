import type { Outlet } from '../types';

/**
 * Outlets we poll directly. Each entry names the publisher, its ownership
 * group and its home country, because the "confirmed" rule counts distinct
 * owners rather than distinct URLs.
 */
export interface FeedDef {
  id: string;
  /** RSS, Atom or RDF. Parsed by lib/xml.ts, which handles all three. */
  url: string;
  outlet: Outlet;
  /** 'news' for text reporting; 'tv' for broadcaster video channels. */
  sourceType: 'news' | 'tv';
  /** Feeds that only ever carry one topic pre-tag their items. */
  forceCategory?: string;
}

const O = (domain: string, name: string, owner: string, country: string | null): Outlet => ({
  domain,
  name,
  owner,
  country,
});

/**
 * Text news feeds. Spread across owners and countries on purpose: two outlets
 * under one owner cannot confirm each other, so a list weighted to one group
 * would rarely produce a confirmed story.
 *
 * Every feed here was verified live by scripts/verify-sources.mjs. Four were
 * removed after testing rather than left in to fail quietly:
 *   - Reuters (reutersagency.com) redirects to a dead endpoint; Reuters has no
 *     public RSS feed any more.
 *   - Associated Press has no public RSS feed; third-party relays for it were
 *     unreliable.
 *   - ABC Australia's world feed returns 404.
 *   - ReliefWeb's RSS returns 406 "Blocked due to bot activity".
 *   - CBC's world feed timed out on every attempt, direct and relayed.
 * Adding an outlet means adding one entry here plus a probe in the harness.
 */
export const NEWS_FEEDS: FeedDef[] = [
  // One outlet publishes many sections, and a single "world" feed misses most
  // of what it runs. These all resolve to the same Outlet objects, so adding
  // them widens coverage without inflating the independent-owner count that
  // the confirmation rule depends on.
  { id: 'bbc-top', url: 'https://feeds.bbci.co.uk/news/rss.xml', outlet: O('bbc.co.uk', 'BBC News', 'BBC', 'GB'), sourceType: 'news' },
  { id: 'bbc-africa', url: 'https://feeds.bbci.co.uk/news/world/africa/rss.xml', outlet: O('bbc.co.uk', 'BBC News', 'BBC', 'GB'), sourceType: 'news' },
  { id: 'bbc-asia', url: 'https://feeds.bbci.co.uk/news/world/asia/rss.xml', outlet: O('bbc.co.uk', 'BBC News', 'BBC', 'GB'), sourceType: 'news' },
  { id: 'bbc-europe', url: 'https://feeds.bbci.co.uk/news/world/europe/rss.xml', outlet: O('bbc.co.uk', 'BBC News', 'BBC', 'GB'), sourceType: 'news' },
  { id: 'bbc-mideast', url: 'https://feeds.bbci.co.uk/news/world/middle_east/rss.xml', outlet: O('bbc.co.uk', 'BBC News', 'BBC', 'GB'), sourceType: 'news' },
  { id: 'bbc-us-canada', url: 'https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml', outlet: O('bbc.co.uk', 'BBC News', 'BBC', 'GB'), sourceType: 'news' },
  { id: 'bbc-latam', url: 'https://feeds.bbci.co.uk/news/world/latin_america/rss.xml', outlet: O('bbc.co.uk', 'BBC News', 'BBC', 'GB'), sourceType: 'news' },
  { id: 'bbc-business', url: 'https://feeds.bbci.co.uk/news/business/rss.xml', outlet: O('bbc.co.uk', 'BBC News', 'BBC', 'GB'), sourceType: 'news' },
  { id: 'bbc-science', url: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml', outlet: O('bbc.co.uk', 'BBC News', 'BBC', 'GB'), sourceType: 'news' },
  { id: 'bbc-politics', url: 'https://feeds.bbci.co.uk/news/politics/rss.xml', outlet: O('bbc.co.uk', 'BBC News', 'BBC', 'GB'), sourceType: 'news' },

  { id: 'guardian-intl', url: 'https://www.theguardian.com/international/rss', outlet: O('theguardian.com', 'The Guardian', 'Guardian Media Group', 'GB'), sourceType: 'news' },
  { id: 'guardian-mideast', url: 'https://www.theguardian.com/world/middleeast/rss', outlet: O('theguardian.com', 'The Guardian', 'Guardian Media Group', 'GB'), sourceType: 'news' },
  { id: 'guardian-africa', url: 'https://www.theguardian.com/world/africa/rss', outlet: O('theguardian.com', 'The Guardian', 'Guardian Media Group', 'GB'), sourceType: 'news' },
  { id: 'guardian-asia', url: 'https://www.theguardian.com/world/asia/rss', outlet: O('theguardian.com', 'The Guardian', 'Guardian Media Group', 'GB'), sourceType: 'news' },
  { id: 'guardian-americas', url: 'https://www.theguardian.com/world/americas/rss', outlet: O('theguardian.com', 'The Guardian', 'Guardian Media Group', 'GB'), sourceType: 'news' },
  { id: 'guardian-europe', url: 'https://www.theguardian.com/world/europe-news/rss', outlet: O('theguardian.com', 'The Guardian', 'Guardian Media Group', 'GB'), sourceType: 'news' },
  { id: 'guardian-business', url: 'https://www.theguardian.com/business/rss', outlet: O('theguardian.com', 'The Guardian', 'Guardian Media Group', 'GB'), sourceType: 'news' },
  { id: 'guardian-env', url: 'https://www.theguardian.com/environment/rss', outlet: O('theguardian.com', 'The Guardian', 'Guardian Media Group', 'GB'), sourceType: 'news' },

  { id: 'dw-all', url: 'https://rss.dw.com/rdf/rss-en-all', outlet: O('dw.com', 'Deutsche Welle', 'Deutsche Welle', 'DE'), sourceType: 'news' },
  { id: 'dw-business', url: 'https://rss.dw.com/rdf/rss-en-bus', outlet: O('dw.com', 'Deutsche Welle', 'Deutsche Welle', 'DE'), sourceType: 'news' },
  { id: 'dw-asia', url: 'https://rss.dw.com/rdf/rss-en-asia', outlet: O('dw.com', 'Deutsche Welle', 'Deutsche Welle', 'DE'), sourceType: 'news' },
  { id: 'dw-europe', url: 'https://rss.dw.com/rdf/rss-en-eu', outlet: O('dw.com', 'Deutsche Welle', 'Deutsche Welle', 'DE'), sourceType: 'news' },

  { id: 'france24-africa', url: 'https://www.france24.com/en/africa/rss', outlet: O('france24.com', 'France 24', 'France Medias Monde', 'FR'), sourceType: 'news' },
  { id: 'france24-mideast', url: 'https://www.france24.com/en/middle-east/rss', outlet: O('france24.com', 'France 24', 'France Medias Monde', 'FR'), sourceType: 'news' },
  { id: 'france24-asia', url: 'https://www.france24.com/en/asia-pacific/rss', outlet: O('france24.com', 'France 24', 'France Medias Monde', 'FR'), sourceType: 'news' },
  { id: 'france24-americas', url: 'https://www.france24.com/en/americas/rss', outlet: O('france24.com', 'France 24', 'France Medias Monde', 'FR'), sourceType: 'news' },
  { id: 'france24-europe', url: 'https://www.france24.com/en/europe/rss', outlet: O('france24.com', 'France 24', 'France Medias Monde', 'FR'), sourceType: 'news' },

  { id: 'npr-news', url: 'https://feeds.npr.org/1001/rss.xml', outlet: O('npr.org', 'NPR', 'NPR', 'US'), sourceType: 'news' },
  { id: 'npr-business', url: 'https://feeds.npr.org/1006/rss.xml', outlet: O('npr.org', 'NPR', 'NPR', 'US'), sourceType: 'news' },
  { id: 'npr-politics', url: 'https://feeds.npr.org/1014/rss.xml', outlet: O('npr.org', 'NPR', 'NPR', 'US'), sourceType: 'news' },

  // Section ids verified against each feed's own <title>, not assumed.
  { id: 'scmp-china', url: 'https://www.scmp.com/rss/4/feed', outlet: O('scmp.com', 'South China Morning Post', 'Alibaba Group', 'HK'), sourceType: 'news' },
  { id: 'scmp-hongkong', url: 'https://www.scmp.com/rss/2/feed', outlet: O('scmp.com', 'South China Morning Post', 'Alibaba Group', 'HK'), sourceType: 'news' },
  { id: 'scmp-business', url: 'https://www.scmp.com/rss/92/feed', outlet: O('scmp.com', 'South China Morning Post', 'Alibaba Group', 'HK'), sourceType: 'news' },
  { id: 'scmp-economy', url: 'https://www.scmp.com/rss/12/feed', outlet: O('scmp.com', 'South China Morning Post', 'Alibaba Group', 'HK'), sourceType: 'news' },

  { id: 'bbc-world', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', outlet: O('bbc.co.uk', 'BBC News', 'BBC', 'GB'), sourceType: 'news' },
  { id: 'aljazeera-all', url: 'https://www.aljazeera.com/xml/rss/all.xml', outlet: O('aljazeera.com', 'Al Jazeera', 'Al Jazeera Media Network', 'QA'), sourceType: 'news' },
  { id: 'guardian-world', url: 'https://www.theguardian.com/world/rss', outlet: O('theguardian.com', 'The Guardian', 'Guardian Media Group', 'GB'), sourceType: 'news' },
  { id: 'npr-world', url: 'https://feeds.npr.org/1004/rss.xml', outlet: O('npr.org', 'NPR', 'NPR', 'US'), sourceType: 'news' },
  { id: 'dw-world', url: 'https://rss.dw.com/rdf/rss-en-world', outlet: O('dw.com', 'Deutsche Welle', 'Deutsche Welle', 'DE'), sourceType: 'news' },
  { id: 'france24', url: 'https://www.france24.com/en/rss', outlet: O('france24.com', 'France 24', 'France Medias Monde', 'FR'), sourceType: 'news' },
  { id: 'un-news', url: 'https://news.un.org/feed/subscribe/en/news/all/rss.xml', outlet: O('news.un.org', 'UN News', 'United Nations', null), sourceType: 'news' },
  { id: 'scmp-news', url: 'https://www.scmp.com/rss/91/feed', outlet: O('scmp.com', 'South China Morning Post', 'Alibaba Group', 'HK'), sourceType: 'news' },
];

/**
 * Broadcaster channels. These supply titles and links to video only, never
 * transcripts or claims, so they are listed as press/TV records.
 */
export const TV_FEEDS: FeedDef[] = [
  { id: 'yt-bbcnews', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UC16niRr50-MSBwiO3YDb3RA', outlet: O('youtube.com/@BBCNews', 'BBC News (YouTube)', 'BBC', 'GB'), sourceType: 'tv' },
  { id: 'yt-aljazeera', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCNye-wNBqNL5ZzHSJj3l8Bg', outlet: O('youtube.com/@AlJazeeraEnglish', 'Al Jazeera English (YouTube)', 'Al Jazeera Media Network', 'QA'), sourceType: 'tv' },
  { id: 'yt-dw', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCbbS1GE942k3UVqpLklyhIA', outlet: O('youtube.com/@DWNews', 'DW News (YouTube)', 'Deutsche Welle', 'DE'), sourceType: 'tv' },
  { id: 'yt-un', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UC07-dOwgza1IguKA86jqxNA', outlet: O('youtube.com/@unitednations', 'United Nations (YouTube)', 'United Nations', null), sourceType: 'tv' },
  { id: 'yt-whitehouse', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCYxRlFDqcWM4y7FfpiAN3KQ', outlet: O('youtube.com/@WhiteHouse', 'The White House (YouTube)', 'United States Government', 'US'), sourceType: 'tv' },
];

/**
 * Ownership groups keyed by the domains they control. Used to collapse
 * sibling outlets so they cannot corroborate one another.
 */
const OWNERSHIP: Record<string, string> = {
  'bbc.com': 'BBC',
  'bbc.co.uk': 'BBC',
  'cnn.com': 'Warner Bros. Discovery',
  'nytimes.com': 'The New York Times Company',
  'washingtonpost.com': 'Nash Holdings',
  'wsj.com': 'News Corp',
  'nypost.com': 'News Corp',
  'thetimes.co.uk': 'News Corp',
  'thesun.co.uk': 'News Corp',
  'foxnews.com': 'Fox Corporation',
  'reuters.com': 'Thomson Reuters',
  'apnews.com': 'Associated Press',
  'aljazeera.com': 'Al Jazeera Media Network',
  'theguardian.com': 'Guardian Media Group',
  'telegraph.co.uk': 'Telegraph Media Group',
  'independent.co.uk': 'Independent Digital News & Media',
  'dailymail.co.uk': 'DMG Media',
  'metro.co.uk': 'DMG Media',
  'npr.org': 'NPR',
  'pbs.org': 'PBS',
  'dw.com': 'Deutsche Welle',
  'france24.com': 'France Medias Monde',
  'rfi.fr': 'France Medias Monde',
  'lemonde.fr': 'Groupe Le Monde',
  'spiegel.de': 'Spiegel-Verlag',
  'faz.net': 'FAZIT-Stiftung',
  'cbc.ca': 'CBC/Radio-Canada',
  'ctvnews.ca': 'Bell Media',
  'globalnews.ca': 'Corus Entertainment',
  'abc.net.au': 'Australian Broadcasting Corporation',
  'news.com.au': 'News Corp',
  'smh.com.au': 'Nine Entertainment',
  'theage.com.au': 'Nine Entertainment',
  'scmp.com': 'Alibaba Group',
  'straitstimes.com': 'SPH Media',
  'japantimes.co.jp': 'The Japan Times',
  'nhk.or.jp': 'NHK',
  'thehindu.com': 'The Hindu Group',
  'indiatimes.com': 'Times Group',
  'timesofindia.indiatimes.com': 'Times Group',
  'ndtv.com': 'Adani Group',
  'hindustantimes.com': 'HT Media',
  'dawn.com': 'Dawn Media Group',
  'haaretz.com': 'M. DuMont Schauberg / Schocken',
  'timesofisrael.com': 'The Times of Israel',
  'jpost.com': 'Jerusalem Post Group',
  'tass.com': 'Russian Government',
  'rt.com': 'Russian Government',
  'sputniknews.com': 'Russian Government',
  'xinhuanet.com': 'Chinese Government',
  'globaltimes.cn': 'Chinese Government',
  'cgtn.com': 'Chinese Government',
  'presstv.ir': 'Iranian Government',
  'kyivindependent.com': 'The Kyiv Independent',
  'pravda.com.ua': 'Ukrayinska Pravda',
  'news.un.org': 'United Nations',
  'reliefweb.int': 'United Nations',
  'bloomberg.com': 'Bloomberg L.P.',
  'ft.com': 'Nikkei',
  'economist.com': 'The Economist Group',
  'politico.com': 'Axel Springer',
  'politico.eu': 'Axel Springer',
  'businessinsider.com': 'Axel Springer',
  'axios.com': 'Cox Enterprises',
  'thehill.com': 'Nexstar Media Group',
  'newsweek.com': 'Newsweek Publishing',
  'usatoday.com': 'Gannett',
  'latimes.com': 'Nant Capital',
  'nbcnews.com': 'Comcast',
  'cnbc.com': 'Comcast',
  'msnbc.com': 'Comcast',
  'abcnews.go.com': 'The Walt Disney Company',
  'cbsnews.com': 'Paramount',
  'voanews.com': 'United States Agency for Global Media',
  'rferl.org': 'United States Agency for Global Media',
  'africanews.com': 'Euronews',
  'euronews.com': 'Euronews',
  'arabnews.com': 'Saudi Research and Media Group',
  'thenationalnews.com': 'International Media Investments',
  'middleeasteye.net': 'Middle East Eye',
  'anadoluagency.com': 'Turkish Government',
  'aa.com.tr': 'Turkish Government',
  'trtworld.com': 'Turkish Government',
  'yna.co.kr': 'Yonhap News Agency',
  'koreaherald.com': 'Herald Corporation',
  'channelnewsasia.com': 'Mediacorp',
  'bangkokpost.com': 'Post Publishing',
  'jakartapost.com': 'PT Bina Media Tenggara',
  'batimes.com.ar': 'Grupo Perfil',
  'folha.uol.com.br': 'Grupo Folha',
  'globo.com': 'Grupo Globo',
  'g1.globo.com': 'Grupo Globo',
  'clarin.com': 'Grupo Clarin',
  'eluniversal.com.mx': 'El Universal',
  'elpais.com': 'PRISA',
  'infobae.com': 'Infobae',
  'mg.co.za': 'Mail & Guardian',
  'news24.com': 'Naspers',
  'premiumtimesng.com': 'Premium Times',
  'punchng.com': 'Punch Nigeria',
  'nation.africa': 'Nation Media Group',
  'theeastafrican.co.ke': 'Nation Media Group',
  'thestar.co.ke': 'Radio Africa Group',
};

/** Builds a display name from a bare domain when we have no registry entry. */
const nameFromDomain = (domain: string): string => {
  const core = domain.replace(/^www\./, '').split('.')[0] ?? domain;
  return core
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
};

const FEED_BY_DOMAIN = new Map<string, Outlet>(
  [...NEWS_FEEDS, ...TV_FEEDS].map((f) => [f.outlet.domain, f.outlet]),
);

/**
 * Resolves an arbitrary domain to an Outlet. Domains we have no ownership
 * record for become their own owner, which is stated in the UI so a reader
 * knows the independence check for that outlet rests on the domain alone.
 */
export function resolveOutlet(rawDomain: string, country: string | null = null): Outlet {
  const domain = rawDomain.replace(/^www\./, '').toLowerCase();
  const known = FEED_BY_DOMAIN.get(domain);
  if (known) return known;

  // Try the registrable domain too, so subdomains inherit their parent's owner.
  const parts = domain.split('.');
  const parent = parts.length > 2 ? parts.slice(-2).join('.') : domain;
  const owner = OWNERSHIP[domain] ?? OWNERSHIP[parent] ?? null;

  return {
    domain,
    name: nameFromDomain(domain),
    owner: owner ?? `domain:${domain}`,
    country,
  };
}

/** True when the ownership group is a guess derived from the domain. */
export const isOwnerInferred = (outlet: Outlet): boolean => outlet.owner.startsWith('domain:');

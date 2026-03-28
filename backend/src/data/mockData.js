/**
 * Mock catalog, metadata, and streams for Phase 1.
 * Uses public test streams (Big Buck Bunny, Tears of Steel, etc.).
 */

export const catalog = [
  { id: "bb_bunny", type: "movie", title: "Big Buck Bunny", poster: "https://peach.blender.org/wp-content/uploads/bbb-splash.png?x11286", year: 2008 },
  { id: "tears_of_steel", type: "movie", title: "Tears of Steel", poster: "https://mango.blender.org/wp-content/uploads/tearsofsteel_thumbnail.jpg", year: 2012 },
  { id: "sintel", type: "movie", title: "Sintel", poster: "https://durian.blender.org/wp-content/uploads/sintel-2560x1440.jpg", year: 2010 },
  { id: "elephants_dream", type: "movie", title: "Elephant's Dream", poster: "https://orange.blender.org/wp-content/uploads/ed_render_3.jpg", year: 2006 },
  { id: "bipbop", type: "movie", title: "Bipbop (Apple fMP4)", poster: "https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/bipbop_adv_example_fmp4_thumbnail.jpg", year: null },
];

export const meta = {
  bb_bunny: {
    id: "bb_bunny",
    type: "movie",
    name: "Big Buck Bunny",
    description: "A giant rabbit deals with three bullies in this short film from the Blender Institute.",
    poster: "https://peach.blender.org/wp-content/uploads/bbb-splash.png?x11286",
    releaseInfo: "2008",
    runtime: "00:09",
  },
  tears_of_steel: {
    id: "tears_of_steel",
    type: "movie",
    name: "Tears of Steel",
    description: "Sci-fi short film shot in Amsterdam, blending live action and CGI.",
    poster: "https://mango.blender.org/wp-content/uploads/tearsofsteel_thumbnail.jpg",
    releaseInfo: "2012",
    runtime: "00:12",
  },
  sintel: {
    id: "sintel",
    type: "movie",
    name: "Sintel",
    description: "A young woman searches for her lost dragon companion in this fantasy short.",
    poster: "https://durian.blender.org/wp-content/uploads/sintel-2560x1440.jpg",
    releaseInfo: "2010",
    runtime: "00:14",
  },
  elephants_dream: {
    id: "elephants_dream",
    type: "movie",
    name: "Elephant's Dream",
    description: "The first short film from the Blender Foundation open movie project.",
    poster: "https://orange.blender.org/wp-content/uploads/ed_render_3.jpg",
    releaseInfo: "2006",
    runtime: "00:10",
  },
  bipbop: {
    id: "bipbop",
    type: "movie",
    name: "Bipbop (Apple fMP4)",
    description: "Apple Advanced HLS fMP4 example stream for testing.",
    poster: "https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/bipbop_adv_example_fmp4_thumbnail.jpg",
    releaseInfo: null,
    runtime: null,
  },
};

/** Playable stream URLs – public test streams only */
export const streams = {
  bb_bunny: [
    { name: "HLS (Mux)", url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8", type: "hls" },
    { name: "MP4", url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4", type: "mp4" },
  ],
  tears_of_steel: [
    { name: "HLS (Unified)", url: "https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8", type: "hls" },
    { name: "HLS (MP4 wrapper)", url: "https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.mp4/.m3u8", type: "hls" },
  ],
  sintel: [
    { name: "HLS (Akamai)", url: "https://bitdash-a.akamaihd.net/content/sintel/hls/playlist.m3u8", type: "hls" },
  ],
  elephants_dream: [
    { name: "MP4", url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4", type: "mp4" },
  ],
  bipbop: [
    { name: "HLS fMP4 (Apple)", url: "https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8", type: "hls" },
  ],
};

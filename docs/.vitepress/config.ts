import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Hopper",
  description:
    "Personal work queue CLI that dispatches engineering work to Claude Code or opencode.",
  base: "/hopper/",
  cleanUrls: true,
  lastUpdated: true,

  head: [
    ["link", { rel: "icon", href: "/hopper/favicon.svg" }],
    ["meta", { name: "theme-color", content: "#5b8def" }],
  ],

  themeConfig: {
    nav: [
      { text: "Home", link: "/" },
      { text: "Profiles", link: "/profiles" },
      { text: "Migration", link: "/migration-3.x-to-4.x" },
      { text: "Opencode spike", link: "/opencode-spike" },
      {
        text: "Releases",
        link: "https://github.com/svetzal/hopper/releases",
      },
      {
        text: "GitHub",
        link: "https://github.com/svetzal/hopper",
      },
    ],

    sidebar: [
      {
        text: "Getting started",
        items: [{ text: "Overview", link: "/" }],
      },
      {
        text: "Configuration",
        items: [{ text: "Profiles", link: "/profiles" }],
      },
      {
        text: "Upgrading",
        items: [
          { text: "3.x → 4.x migration", link: "/migration-3.x-to-4.x" },
          { text: "2.x → 3.x migration", link: "/migration-2.x-to-3.x" },
        ],
      },
      {
        text: "Design notes",
        items: [{ text: "opencode CLI spike", link: "/opencode-spike" }],
      },
    ],

    socialLinks: [{ icon: "github", link: "https://github.com/svetzal/hopper" }],

    editLink: {
      pattern: "https://github.com/svetzal/hopper/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },

    footer: {
      message: "Released under the MIT License.",
      copyright: "© 2026 Stacey Vetzal / Mojility Inc.",
    },

    search: {
      provider: "local",
    },
  },
});

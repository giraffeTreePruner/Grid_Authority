/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      screens: {
        /*
          Landscape phones, and any window that is short rather than narrow.

          Keyed on height because height is what is actually scarce there, and a width
          breakpoint says nothing about it: a phone in landscape is 812px wide, so it
          is `sm` and `md` by width while having 375px of height to spend on a map, a
          header, a slider and a footer. 500px is above every phone in landscape and
          below a tablet in portrait.
        */
        short: { raw: '(max-height: 500px)' },
      },
      colors: {
        // A neutral that reads as "no data" rather than as a low value.
        nodata: '#3f3f46',
      },
    },
  },
};

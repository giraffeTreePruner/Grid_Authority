/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // A neutral that reads as "no data" rather than as a low value.
        nodata: '#3f3f46',
      },
    },
  },
};

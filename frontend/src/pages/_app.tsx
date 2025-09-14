import React from 'react';
import type { AppProps } from 'next/app';
import Head from 'next/head';
import { UnravlThemeProvider } from '@/theme/UnravlTheme';

export default function MyApp({ Component, pageProps }: AppProps) {
  return (
    <>
      <Head>
        <meta name="viewport" content="initial-scale=1, width=device-width" />
        <title>Unravl - Interactive Architecture Visualization Platform</title>
        <meta name="description" content="Transform codebases into living, interactive architecture diagrams - the Marauder's Map for software systems" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
      </Head>
      <UnravlThemeProvider timeOfDay="day">
        <Component {...pageProps} />
      </UnravlThemeProvider>
    </>
  );
}
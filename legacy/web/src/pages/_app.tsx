import React from 'react';
import type { AppProps } from 'next/app';
import Head from 'next/head';
import { KlauroThemeProvider } from '@/theme/KlauroTheme';
import { AuthProvider } from '@/contexts/AuthContext';
import { WorkspaceProvider } from '@/contexts/WorkspaceContext';

export default function MyApp({ Component, pageProps }: AppProps) {
  return (
    <>
      <Head>
        <meta name="viewport" content="initial-scale=1, width=device-width" />
        <title>Klauro - Interactive Architecture Visualization Platform</title>
        <meta name="description" content="Transform codebases into living, interactive architecture diagrams - the Marauder's Map for software systems" />
      </Head>
      <KlauroThemeProvider timeOfDay="day">
        <AuthProvider>
          <WorkspaceProvider>
            <Component {...pageProps} />
          </WorkspaceProvider>
        </AuthProvider>
      </KlauroThemeProvider>
    </>
  );
}

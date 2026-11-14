"use client";

import React, { useEffect, useState } from 'react';
import { Playground } from '../../src/views/Playground';
import { PlaygroundLocked } from '../../src/components/PlaygroundLocked';
import { PLAYGROUND_CONFIG } from '../../src/constants';
import { useAuth } from '../../src/context/AuthContext';
import { supabase } from '../../src/lib/supabase';
import { LiveKitRoom, RoomAudioRenderer } from '@livekit/components-react';

export default function Page() {
  const { currentUser } = useAuth();
  const [token, setToken] = useState<string | null>(null);

  const livekitUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL || 'wss://othrhalff-tmqcxj0g.livekit.cloud';

  useEffect(() => {
    if (PLAYGROUND_CONFIG.isLocked) return;

    let isMounted = true;
    const fetchToken = async () => {
      try {
        // /api/livekit-token requires a verified Supabase JWT; identity is
        // derived server-side from auth.uid(), so no identity param is sent.
        const { data: sessionData } = await supabase.auth.getSession();
        const accessToken = sessionData?.session?.access_token;
        if (!accessToken) {
          console.warn('[LiveKit Token Error]: no active session — voice disabled');
          return;
        }
        const name = currentUser?.realName || 'Student';
        const res = await fetch(
          `/api/livekit-token?room=playground-global-voice&name=${encodeURIComponent(name)}`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        const data = await res.json();
        if (isMounted && data.token) {
          setToken(data.token);
        }
      } catch (err) {
        console.warn('[LiveKit Token Error]:', err);
      }
    };

    fetchToken();
    return () => {
      isMounted = false;
    };
  }, [currentUser]);

  if (PLAYGROUND_CONFIG.isLocked) {
    return <PlaygroundLocked />;
  }

  if (!token) {
    return <Playground />;
  }

  return (
    <LiveKitRoom
      serverUrl={livekitUrl}
      token={token}
      connect={true}
      audio={false}
      video={false}
      className="w-full h-full"
    >
      <RoomAudioRenderer />
      <Playground />
    </LiveKitRoom>
  );
}


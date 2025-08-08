// src/hls.ts

import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Router, Producer } from 'mediasoup/node/lib/types';



const hlsRecorders = new Map<string, {
    process: ChildProcessWithoutNullStreams;
    cleanup: () => void;
}>();

const HLS_OUTPUT_DIR = path.resolve(process.cwd(), 'public', 'hls');

if (!fs.existsSync(HLS_OUTPUT_DIR)) {
    fs.mkdirSync(HLS_OUTPUT_DIR, { recursive: true });
}

function spawnFfmpeg(roomId: string, sdpFilePath: string): ChildProcessWithoutNullStreams {
    const outputDir = path.join(HLS_OUTPUT_DIR, roomId);
    console.log(`[HLS Backend] HLS files for room ${roomId} will be saved in: ${outputDir}`);

    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const ffmpegArgs = [
         '-loglevel', 'verbose',
        '-protocol_whitelist', 'file,udp,rtp',
        '-rtcp_port', '-1', // Add this line to disable RTCP
        '-i', sdpFilePath,
        '-map', '0:v:0',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-tune', 'zerolatency',
        '-pix_fmt', 'yuv420p',
         '-an',
        '-f', 'hls',
        '-hls_time', '2',
        '-hls_list_size', '5',
        '-hls_flags', 'delete_segments',
        '-hls_segment_filename', path.join(outputDir, 'segment_%03d.ts'),
        path.join(outputDir, 'stream.m3u8')
    ];

    console.log(`[HLS Backend] Spawning FFmpeg for room ${roomId}: ffmpeg ${ffmpegArgs.join(' ')}`);
    const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

    ffmpegProcess.stderr.on('data', (data) => {
        console.error(`[FFMPEG STDERR] Room ${roomId}: ${data}`);
    });

    ffmpegProcess.on('error', (err) => {
        console.error(`[FFMPEG ERROR] Room ${roomId}:`, err);
        stopHlsRecording(roomId);
    });

    ffmpegProcess.on('close', (code) => {
        console.log(`[FFMPEG CLOSE] Process for room ${roomId} exited with code ${code}.`);
    });

    return ffmpegProcess;
}

export async function startHlsRecording(roomId: string, producer: Producer, router: Router) {
    if (hlsRecorders.has(roomId)) {
        console.warn(`[HLS Backend] Recording already active for room ${roomId}. Ignoring request.`);
        return;
    }

    console.log(`[HLS Backend] Starting HLS recording for producer: ${producer.id} in room: ${roomId}`);

    console.log(`[HLS Backend] Creating PlainTransport for FFmpeg...`);
    //const port = await getFreeUdpPort()
    const plainTransport = await router.createPlainTransport({
        listenIp: { ip: '127.0.0.1' },
        port:49991,
        // FFmpeg requires separate RTP and RTCP ports when using SDP.
        rtcpMux: true, 
        // comedia: true is not needed here and can complicate things.
    });
    console.log(`[HLS Backend] PlainTransport created with ID: ${plainTransport.id}`);

    const rtpPort = plainTransport.tuple.localPort;

    console.log(`[HLS Backend] PlainTransport RTP port: ${rtpPort}`);
    const rtpIp = plainTransport.tuple.localIp;

    console.log(`[HLS Backend] Creating consumer for producer ${producer.id}...`);
    const consumer = await plainTransport.consume({
        producerId: producer.id,
        rtpCapabilities: router.rtpCapabilities,
        paused: true,
    });
    console.log(`[HLS Backend] Consumer created with ID: ${consumer.id}`);

    const { kind } = consumer;
    const codec = consumer.rtpParameters.codecs[0];

const sdpContent = `
v=0
o=- 0 0 IN IP4 ${rtpIp}
s=FFmpeg
c=IN IP4 ${rtpIp}
t=0 0
m=${kind} ${rtpPort} RTP/AVP ${codec.payloadType}
a=rtpmap:${codec.payloadType} ${codec.mimeType.split('/')[1]}/${codec.clockRate}${kind === 'audio' ? '/' + codec.channels : ''}
${codec.parameters ? `a=fmtp:${codec.payloadType} ${Object.entries(codec.parameters).map(([key, value]) => `${key}=${value}`).join(';')}` : ''}
${codec.rtcpFeedback?.map(fb => `a=rtcp-fb:${codec.payloadType} ${fb.type} ${fb.parameter || ''}`).join('\n')}
a=recvonly
`;

    const sdpFilePath = path.join('/tmp', `hls-stream-${roomId}.sdp`);
    fs.writeFileSync(sdpFilePath, sdpContent);
    console.log(`[HLS Backend] Generated SDP file for room ${roomId} at ${sdpFilePath}`);
    console.log(`[HLS Backend] SDP Content:\n---${sdpContent}\n---`);


    const ffmpegProcess = spawnFfmpeg(roomId, sdpFilePath);

    const cleanup = () => {
    try {
        if (ffmpegProcess && !ffmpegProcess.killed) {
            console.log(`[HLS] Killing FFmpeg process for room ${roomId}`);
            ffmpegProcess.kill('SIGINT'); // or 'SIGKILL' for force
        }
        if (!consumer.closed) {
            console.log(`[HLS] Closing consumer for room ${roomId}`);
            consumer.close();
        }
        if (!plainTransport.closed) {
            console.log(`[HLS] Closing transport for room ${roomId}`);
            plainTransport.close();
        }

        if (fs.existsSync(sdpFilePath)) {
            fs.unlinkSync(sdpFilePath);
        }

        const hlsDir = path.join(HLS_OUTPUT_DIR, roomId);
        if (fs.existsSync(hlsDir)) {
            fs.rmSync(hlsDir, { recursive: true, force: true });
        }
    } catch (err) {
        console.error(`[HLS Cleanup] Error during cleanup for room ${roomId}:`, err);
    }
};

    producer.on('@close', () => {
        console.log(`[HLS Backend] Producer ${producer.id} closed, stopping recording for room ${roomId}`);
        stopHlsRecording(roomId);
    });

    hlsRecorders.set(roomId, { process: ffmpegProcess, cleanup });

    await consumer.resume();
    console.log(`[HLS Backend] ✅ Consumer resumed. HLS recording is now ACTIVE for room ${roomId}.`);
}

export function stopHlsRecording(roomId: string) {
    const recorder = hlsRecorders.get(roomId);
    if (!recorder) return;

    console.log(`[HLS Backend] STOP HLS RECORDING called for room ${roomId}.`);
    recorder.cleanup();
    hlsRecorders.delete(roomId);
}
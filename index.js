/**
 * index.js
 * Entry point for the OpenAI Speech-to-Speech streaming application.
 * This server handles real-time audio streaming between clients and OpenAI's API,
 * performing necessary audio format conversions and WebSocket communication.
 *
 * @author Agent Voice Response <info@agentvoiceresponse.com>
 * @see https://www.agentvoiceresponse.com
 */

const express = require("express");
const WebSocket = require("ws");
require("dotenv").config();

const INTERVAL_MS = parseInt(process.env.INTERVAL_MS) || 20;

// Initialize Express application
const app = express();

/**
 * Audio Processing Utilities
 */

/**
 * Upsamples audio from 8kHz 16-bit mono to 24kHz 16-bit mono using linear interpolation.
 * More efficient than generic resampleAudio for this specific conversion.
 * 
 * @param {Buffer} audioBuffer - Input audio buffer (8kHz, 16-bit, mono)
 * @returns {Buffer} Upsampled audio buffer (24kHz, 16-bit, mono)
 */
const upsample8kTo24k = (audioBuffer) => {
  if (!audioBuffer || audioBuffer.length === 0) {
    return Buffer.alloc(0);
  }

  // 24kHz / 8kHz = 3x upsampling factor
  const upsamplingFactor = 3;
  const bytesPerSample = 2;
  const inputSampleCount = audioBuffer.length / bytesPerSample;
  
  if (inputSampleCount < 2) {
    return audioBuffer;
  }

  const outputSampleCount = inputSampleCount * upsamplingFactor;
  const outputBuffer = Buffer.alloc(outputSampleCount * bytesPerSample);

  for (let i = 0; i < inputSampleCount - 1; i++) {
    // Read current and next sample as 16-bit signed integers
    const currentSample = audioBuffer.readInt16LE(i * bytesPerSample);
    const nextSample = audioBuffer.readInt16LE((i + 1) * bytesPerSample);

    // Generate 3 interpolated samples between current and next
    for (let j = 0; j < upsamplingFactor; j++) {
      const interpolationFactor = j / upsamplingFactor;
      const interpolatedSample = Math.round(
        currentSample + (nextSample - currentSample) * interpolationFactor
      );

      // Clamp to 16-bit range
      const clampedSample = Math.max(-32768, Math.min(32767, interpolatedSample));

      // Write to output buffer
      const outputIndex = (i * upsamplingFactor + j) * bytesPerSample;
      outputBuffer.writeInt16LE(clampedSample, outputIndex);
    }
  }

  // Handle the last sample (repeat it for the remaining upsampled samples)
  const lastSample = audioBuffer.readInt16LE((inputSampleCount - 1) * bytesPerSample);
  for (let j = 0; j < upsamplingFactor; j++) {
    const outputIndex = ((inputSampleCount - 1) * upsamplingFactor + j) * bytesPerSample;
    outputBuffer.writeInt16LE(lastSample, outputIndex);
  }

  return outputBuffer;
};

/**
 * Downsamples audio from 24kHz 16-bit mono to 8kHz 16-bit mono using decimation.
 * More efficient than generic resampleAudio for this specific conversion.
 * 
 * @param {Buffer} audioBuffer - Input audio buffer (24kHz, 16-bit, mono)
 * @returns {Buffer} Downsampled audio buffer (8kHz, 16-bit, mono)
 */
const downsample24kTo8k = (audioBuffer) => {
  if (!audioBuffer || audioBuffer.length === 0) {
    return Buffer.alloc(0);
  }

  // 24kHz / 8kHz = 3x downsampling factor
  const downsamplingFactor = 3;
  const bytesPerSample = 2;
  const inputSampleCount = audioBuffer.length / bytesPerSample;
  
  if (inputSampleCount < downsamplingFactor) {
    return audioBuffer;
  }

  const outputSampleCount = Math.floor(inputSampleCount / downsamplingFactor);
  const outputBuffer = Buffer.alloc(outputSampleCount * bytesPerSample);

  for (let i = 0; i < outputSampleCount; i++) {
    // Take every 3rd sample (decimation)
    const inputIndex = i * downsamplingFactor;
    const sample = audioBuffer.readInt16LE(inputIndex * bytesPerSample);
    outputBuffer.writeInt16LE(sample, i * bytesPerSample);
  }

  return outputBuffer;
};

/**
 * Creates and configures a WebSocket connection to OpenAI's real-time API.
 *
 * @returns {WebSocket} Configured WebSocket instance
 */
const connectToOpenAI = () => {
  const model = process.env.OPENAI_MODEL || "gpt-4o-realtime-preview";
  return new WebSocket(`wss://api.openai.com/v1/realtime?model=${model}`, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });
};

/**
 * Stream Processing
 */

/**
 * Handles incoming client audio stream and manages communication with OpenAI's API.
 * Implements buffering for audio chunks received before WebSocket connection is established.
 *
 * @param {Request} req - Express request object
 * @param {Response} res - Express response object
 */
const handleAudioStream = async (req, res) => {
  console.log("New audio stream received");

  const ws = connectToOpenAI();

  let inputAudioBuffer = Buffer.alloc(0);
  let outputAudioBuffer = Buffer.alloc(0);
  let buffer = Buffer.alloc(0);

  const inputAudioBufferInterval = setInterval(() => {
    if (inputAudioBuffer.length >= 4800 && ws.readyState === WebSocket.OPEN) {
      // Send only one packet of 4800 bytes
      const chunk = inputAudioBuffer.slice(0, 4800);
      ws.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: chunk.toString("base64"),
        })
      );
      
      inputAudioBuffer = inputAudioBuffer.slice(4800);      
    }
  }, 100);

  const outputAudioBufferInterval = setInterval(() => {
    if (outputAudioBuffer.length >= 320) {
      // Send only one packet of 320 bytes (s16le format)
      const chunk = outputAudioBuffer.slice(0, 320);
      res.write(chunk);
      
      // Remove the sent chunk from buffer
      outputAudioBuffer = outputAudioBuffer.slice(320);
    }
  }, INTERVAL_MS);

  // Configure WebSocket event handlers
  ws.on("open", () => {
    console.log("WebSocket connected to OpenAI");

    // Initialize session with audio format specifications
    ws.send(
      JSON.stringify({
        type: "session.update",
        session: {
          instructions:
            process.env.OPENAI_INSTRUCTIONS ||
            "You are a helpful assistant that can answer questions and help with tasks.",
          input_audio_format: "pcm16",
          output_audio_format: "pcm16",
          temperature: +process.env.OPENAI_TEMPERATURE || 0.8,
          max_response_output_tokens: +process.env.OPENAI_MAX_TOKENS || "inf",
        },
      })
    );
  });

  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data);

      switch (message.type) {
        case "error":
          console.error("OpenAI API error:", message.error);
          res.status(500).json({ message: message.error.message });
          break;

        case "session.updated":
          console.log("Session updated:", message);
          break;

        case "response.audio.delta":
          const decoded = Buffer.from(message.delta, "base64");
          console.log("Received audio chunk from OpenAI", decoded.length);
          const resampled = downsample24kTo8k(decoded);
          outputAudioBuffer = Buffer.concat([outputAudioBuffer, resampled]);
          break;

        case "response.audio.done":
          console.log("Audio streaming completed");
          break;

        case "response.audio_transcript.delta":
          // console.log("Received transcript from OpenAI", message.delta);
          break;

        case "response.audio_transcript.done":
          console.log("Final transcript:", message.transcript);
          break;

        case "input_audio_buffer.speech_started":
          console.log("Audio streaming started");
          outputAudioBuffer = Buffer.alloc(0);
          buffer = Buffer.alloc(0);
          break;

        default:
          console.log("Received message type:", message.type);
          break;
      }
    } catch (error) {
      console.error("Error processing WebSocket message:", error);
    }
  });

  ws.on("close", () => {
    console.log("WebSocket connection closed");
    clearInterval(inputAudioBufferInterval);
    clearInterval(outputAudioBufferInterval);
    res.end();
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err);
    clearInterval(inputAudioBufferInterval);
    clearInterval(outputAudioBufferInterval);
    res.end();
  });

      // Handle incoming audio data
    req.on("data", (chunk) => {
      const resampled = upsample8kTo24k(chunk);
      inputAudioBuffer = Buffer.concat([inputAudioBuffer, resampled]);
    });

  req.on("end", () => {
    console.log("Request stream ended");
    ws.close();
  });

  req.on("error", (err) => {
    console.error("Request error:", err);
    ws.close();
  });
};

// API Endpoints
app.post("/speech-to-speech-stream", handleAudioStream);

// Start server
const PORT = process.env.PORT || 6030;
app.listen(PORT, () => {
  console.log(`OpenAI Speech-to-Speech server running on port ${PORT}`);
});

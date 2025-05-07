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

// Initialize Express application
const app = express();

/**
 * Audio Processing Utilities
 */

/**
 * Upsamples 16-bit PCM audio from 8kHz to 24kHz using linear interpolation.
 * This is required as OpenAI's API expects 24kHz audio input.
 * 
 * @param {Buffer} buffer - Input audio buffer in 16-bit PCM format at 8kHz
 * @returns {Buffer} Upsampled audio buffer at 24kHz
 */
const upsample8kHzTo24kHz = (buffer) => {
  const inputSamples = buffer.length / 2;
  const ratio = 3;
  const output = Buffer.alloc(inputSamples * ratio * 2);

  for (let i = 0; i < inputSamples * ratio; i++) {
    const inputIndex = i / ratio;
    const index1 = Math.floor(inputIndex);
    const index2 = Math.min(index1 + 1, inputSamples - 1);
    const fraction = inputIndex - index1;

    const sample1 = buffer.readInt16LE(index1 * 2);
    const sample2 = buffer.readInt16LE(index2 * 2);
    const interpolated = Math.round(sample1 + (sample2 - sample1) * fraction);

    output.writeInt16LE(interpolated, i * 2);
  }

  return output;
};

/**
 * Downsamples 16-bit PCM audio from 24kHz to 8kHz by decimation.
 * This converts OpenAI's 24kHz output back to 8kHz for client compatibility.
 * 
 * @param {Buffer} buffer - Input audio buffer in 16-bit PCM format at 24kHz
 * @returns {Buffer} Downsampled audio buffer at 8kHz
 */
const downsample24kHzTo8kHz = (buffer) => {
  const ratio = 3;
  const outputSamples = Math.floor(buffer.length / 2 / ratio);
  const output = Buffer.alloc(outputSamples * 2);

  for (let i = 0; i < outputSamples; i++) {
    const sample = buffer.readInt16LE(i * ratio * 2);
    output.writeInt16LE(sample, i * 2);
  }

  return output;
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

  const bufferedChunks = [];
  let isWsConnected = false;
  const ws = connectToOpenAI();

  // Configure WebSocket event handlers
  ws.on("open", () => {
    console.log("WebSocket connected to OpenAI");
    
    // Initialize session with audio format specifications
    ws.send(JSON.stringify({
      type: "session.update",
      session: {
        instructions: process.env.OPENAI_INSTRUCTIONS || "You are a helpful assistant that can answer questions and help with tasks.",
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        temperature: +process.env.OPENAI_TEMPERATURE || 0.8,
        max_response_output_tokens: +process.env.OPENAI_MAX_TOKENS || "inf"
      },
    }));
    
    isWsConnected = true;

    // Process any buffered audio chunks
    bufferedChunks.forEach((chunk) => {
      const upsampled = upsample8kHzTo24kHz(chunk);
      ws.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: upsampled.toString("base64"),
      }));
    });
    bufferedChunks.length = 0;
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
          const downsampled = downsample24kHzTo8kHz(decoded);
          res.write(downsampled);
          break;
          
        case "response.audio.done":
          console.log("Audio streaming completed");
          break;
          
        case "response.audio_transcript.done":
          console.log("Final transcript:", message.transcript);
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
    isWsConnected = false;
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err);
    isWsConnected = false;
  });

  // Handle incoming audio data
  req.on("data", (chunk) => {
    try {
      if (isWsConnected) {
        const upsampled = upsample8kHzTo24kHz(chunk);
        ws.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: upsampled.toString("base64"),
        }));
      } else {
        bufferedChunks.push(chunk);
      }
    } catch (error) {
      console.error("Error processing audio chunk:", error);
    }
  });

  req.on("end", () => {
    console.log("Request stream ended");
    ws.close();
    res.end();
  });

  req.on("error", (err) => {
    console.error("Request error:", err);
    try {
      ws.close();
      res.status(500).json({ message: "Stream error" });
    } catch (error) {
      console.error("Error closing WebSocket:", error);
    }
  });

  // Set required headers for streaming
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
};

// API Endpoints
app.post("/speech-to-speech-stream", handleAudioStream);

// Start server
const PORT = process.env.PORT || 6030;
app.listen(PORT, () => {
  console.log(`OpenAI Speech-to-Speech server running on port ${PORT}`);
});
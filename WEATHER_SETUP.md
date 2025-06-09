# Weather API Setup

The `/weather` command now uses **real weather data** from multiple sources for reliability.

## How It Works

The weather command uses a smart fallback system:
1. **Primary**: OpenWeatherMap API (if you have an API key)
2. **Fallback**: wttr.in service (free, no API key required)

This ensures the weather command always works, even without API setup!

## Quick Start (No Setup Required)

The weather command works immediately with the free fallback service:
- `/weather New York` - Get weather for New York
- `/weather London` - Get weather for London
- `/weather Tokyo` - Get weather for Tokyo

## Optional: Enhanced Features with API Key

For the best experience, you can set up a free OpenWeatherMap API key:

### Setup Instructions

1. **Get a free API key:**
   - Go to [OpenWeatherMap](https://openweathermap.org/api)
   - Sign up for a free account
   - Get your API key

2. **Configure the API key:**
   - Copy `.env.example` to `.env`
   - Replace `your_api_key_here` with your actual API key
   - Example: `OPENWEATHER_API_KEY=abc123def456ghi789`

3. **Restart the server:**
   - Stop the server (Ctrl+C)
   - Start it again with `npm start`

### Enhanced Features with API Key

- **More precise coordinates**
- **Wind speed in m/s**
- **Additional weather details**
- **Higher reliability**

## Features

- ✅ **Real weather data** for any city worldwide
- ✅ **Temperature** in both Celsius and Fahrenheit  
- ✅ **Weather conditions** with appropriate emojis
- ✅ **Humidity and wind information**
- ✅ **Automatic fallback** if primary service fails
- ✅ **Error handling** for invalid cities

## Usage Examples

- `/weather New York` - Current weather in New York
- `/weather London, UK` - Specify country for clarity
- `/weather Toronto` - Works with any major city
- `/weather` - Shows error asking for city name

## Troubleshooting

- **"City not found"**: Check spelling or try a major city name
- **Still getting simulated data?**: Make sure you restarted the server
- **Service unavailable**: The fallback service will automatically be used

## Technical Details

- **Primary Service**: OpenWeatherMap (requires API key)
- **Fallback Service**: wttr.in (free, no registration)
- **Rate Limits**: 1,000 calls/day (OpenWeatherMap free tier)
- **Response Time**: Usually under 2 seconds

The system automatically detects API failures and switches to the backup service seamlessly!

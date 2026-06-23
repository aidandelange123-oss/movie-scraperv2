![Example](example.gif)

# 🎬 Zenith Movies (Ad-Free Scraper)

A simple movie streaming frontend that pulls video sources using scripts originally based on Vidlink. This version removes ads and provides a clean, minimal playback experience.

## 🚀 Features

* 🎥 Stream movies directly in-browser
* ⚡ Fast loading using HLS streams
* 🚫 No ads (cleaned version of original scripts)
* 🌐 Deployed easily with Vercel
* 🔗 Simple URL-based playback system

## 🧠 How It Works

This project uses a scraping/proxy approach to retrieve video streams and display them in a native HTML5 player.

Example:

```
https://your-site.vercel.app/?id=550
```

* `id` = Movie ID (typically from TMDB or similar source)
* The app fetches and injects the stream into a video player
* Playback is handled using HLS

## 📁 Project Structure

```
/
├── index.html        # Main frontend
├── script.js         # Handles fetching + playback
├── style.css         # Basic styling
└── /api              # Serverless functions (proxy/scraper logic)
```

## 🛠️ Deployment (Vercel)

1. Clone or fork this repo
2. Go to https://vercel.com
3. Click **"Add New Project"**
4. Import your repo
5. Deploy (no config needed)

Once deployed, your site will be live instantly.

## ⚠️ Important Notes

* This project is for **educational purposes only**
* Streaming copyrighted content without permission may violate laws in your country
* The original scripts were modified to remove ads, but credit belongs to their respective creators

## 📌 Usage

Just open:

```
https://your-vercel-url.vercel.app/?id=MOVIE_ID
```

That’s it. No accounts, no UI clutter — just press play.

## 💡 Future Improvements

* Custom video player UI
* Subtitles support
* TV / remote-friendly controls
* Better error handling

---

## ⭐ Support

If you like this project, consider giving it a star ⭐ on GitHub!

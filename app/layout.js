import "./globals.css";

export const metadata = {
  title: "Waves TTS Playground",
  description: "A small Next.js demo integrating Smallest.ai Waves Text-to-Speech."
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

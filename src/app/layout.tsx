import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
	variable: "--font-inter",
	subsets: ["latin"],
});

export const metadata: Metadata = {
	title: "UNBOUND — Drone Education",
	description: "Drone education, access, and freedom.",
};

export default function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	return (
		<html lang="en">
			<head>
				<script
					type="importmap"
					dangerouslySetInnerHTML={{
						__html: JSON.stringify({
							imports: {
								three: "https://unpkg.com/three@0.160.0/build/three.module.js",
							},
						}),
					}}
				/>
			</head>
			<body className={inter.variable}>{children}</body>
		</html>
	);
}

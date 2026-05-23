"use client";

import { useEffect } from "react";

export default function Home() {
	useEffect(() => {
		const w = window as Window & {
			__UNBOUND_SCENE_CLEANUP?: () => void;
			__UNBOUND_SCENE_LOADED?: boolean;
		};
		if (w.__UNBOUND_SCENE_LOADED) return;
		w.__UNBOUND_SCENE_LOADED = true;

		const script = document.createElement("script");
		script.type = "module";
		script.src = "/js/main.js";
		document.body.appendChild(script);

		return () => {
			w.__UNBOUND_SCENE_CLEANUP?.();
			w.__UNBOUND_SCENE_CLEANUP = undefined;
			w.__UNBOUND_SCENE_LOADED = false;
			script.remove();
		};
	}, []);

	return (
			<>
				<div id="loading-screen">
					<div className="loading-content">
						<img src="/logo-big.png" alt="UNBOUND" className="loading-logo" />
						<div id="loading-items" className="loading-items"></div>
						<div className="loading-progress-track">
							<div id="loading-progress-bar" className="loading-progress-fill"></div>
						</div>
					</div>
				</div>
				<canvas id="c" />
<div id="memory-stats" className="memory-stats" style={{ display: 'none' }}>
  <span id="mem-total">-</span>
</div>
				<button id="debug-textures" className="debug-toggle active">Textures on</button>
				<button id="debug-clouds" className="debug-toggle active">Clouds on</button>
				<button id="debug-atmosphere" className="debug-toggle active">Atmosphere on</button>
				<button id="debug-burn" className="debug-toggle">Burn off</button>
				<button id="debug-shadows" className="debug-toggle active">Shadows on</button>
				<button id="debug-lod" className="debug-toggle active">Distance LOD on</button>
				<div id="debug-aggression-wrap">
					<label htmlFor="debug-aggression">LOD aggression</label>
					<input type="range" id="debug-aggression" min="0.3" max="4.0" step="0.1" defaultValue="1.5" />
					<span id="debug-aggression-val">1.5</span>
				</div>
				<button id="debug-lod-mode" className="debug-toggle">LOD: angular</button>
				<button id="debug-texture-lod" className="debug-toggle active">Texture LOD on</button>
				<button id="debug-smooth" className="debug-toggle">Smooth bump</button>
<button id="debug-wireframe" className="debug-toggle">Wireframe</button>
<button id="debug-memory" className="debug-toggle">Memory stats</button>

			<nav>
				<div className="nav-inner">
					<a href="#hero" className="brand">
						<img src="/logo-big.png" alt="UNBOUND" className="brand-logo" /> UNBOUND
					</a>
					<div className="nav-links">
						<button className="nav-link active" data-section="hero">Home</button>
						<button className="nav-link" data-section="about">About</button>
						<button className="nav-link" data-section="features">Vision</button>
						<button className="nav-link" data-section="programs">Programs</button>
						<button className="nav-link" data-section="impact">Impact</button>
						<button className="nav-link" data-section="contact">Contact</button>
					</div>
				</div>
			</nav>

			<div className="scroll-content">
				<section id="hero">
					<div className="section-inner">
						<div className="overlay-text">
							<span className="eyebrow">Drone Education &bull; Robotics &bull; Access &bull; Community</span>
							<h1>UNBOUND</h1>
							<p className="body-text">UNBOUND is an organization built to make drone education accessible in San Jose. The goal is to create a place where students and beginners can explore drones as a real form of robotics through coaching sessions, hands-on builds, and flight experiences that feel exciting, creative, and meaningful.</p>
							<p className="body-text">From learning with DJI Tello to understanding hardware connections in FPV drones, and from coding to outreach for children who are stuck indoors because of medical conditions, UNBOUND is about helping people experience curiosity, freedom, and engineering in a way that feels real.</p>
							<div className="btn-group">
								<a href="#programs" className="btn btn-primary">Explore programs</a>
								<a href="#about" className="btn btn-outline btn-glass">Learn more</a>
							</div>
						</div>
					</div>
				</section>

				<section id="about">
					<div className="section-inner">
						<div className="overlay-text right">
							<span className="eyebrow">About UNBOUND</span>
							<h2>About UNBOUND</h2>
							<p className="body-text">UNBOUND started from a simple realization: despite being in the heart of Silicon Valley, there are very few accessible opportunities for students to learn about drones in a structured, hands-on way.</p>
							<p className="body-text">Drones combine hardware, software, control systems, and creativity, but for many people, getting started feels unclear or inaccessible.</p>
							<p className="body-text">UNBOUND was created to change that.</p>
							<p className="body-text">At the same time, drones represent something more than technology. They represent movement, perspective, and freedom. That is why UNBOUND also focuses on outreach for children who are often confined indoors due to medical conditions, helping them experience flight in a way that feels real and meaningful.</p>
						</div>
					</div>
				</section>

				<section id="features">
					<div className="section-inner">
						<div className="overlay-text">
							<span className="eyebrow">What makes UNBOUND different</span>
							<h2>What makes UNBOUND different</h2>
							<p className="body-text">This is not a general STEM club and not a sports organization. It is centered specifically on drones, flight, robotics, and the freedom those experiences can create.</p>
							<div className="stat-row">
								<div className="stat"><h4>Drone-first learning</h4><span>Focused specifically on drones rather than broad engineering topics, so students can go deeper into flight systems, controls, and real-world applications.</span></div>
							</div>
							<div className="stat-row">
								<div className="stat"><h4>Hands-on building</h4><span>Students do not just watch demonstrations. They learn through hardware connections, components, setup, and practical problem-solving.</span></div>
							</div>
							<div className="stat-row">
								<div className="stat"><h4>Freedom and inspiration</h4><span>UNBOUND also brings drone experiences to children whose medical conditions keep them indoors, helping them feel wonder, movement, and connection.</span></div>
							</div>
						</div>
					</div>
				</section>

				<section id="programs">
					<div className="section-inner">
						<div className="overlay-text right">
							<span className="eyebrow">Programs</span>
							<h2>Programs</h2>
							<p className="body-text">UNBOUND can grow through several kinds of sessions, each designed to make drones approachable for different ages and experience levels.</p>
							<p className="body-text">Competitive drone hackathons where participants design and code flight solutions for obstacle-based challenges. Teams apply programming, problem-solving, and real-time debugging skills, with awards recognizing innovation, efficiency, and performance.</p>
							<p className="body-text">Beginner-friendly sessions focused on programming DJI Tello drones. Students learn to write code to control takeoff, landing, movement, and basic flight patterns, while building foundational skills in logic, sequencing, and real-time control through hands-on challenges.</p>
							<p className="body-text">Sessions introducing how drones connect to robotics concepts such as sensors, motors, control systems, stability, and communication. Additional workshops focus on FPV drone structure, hardware connections, components, and how a drone comes together as a complete system.</p>
							<p className="body-text">Outreach sessions are designed for patients, especially children, who may not be able to go outside. Using drones near windows or open spaces, participants can control flight and explore the outside world in a safe, guided way, turning coding into a tool for curiosity, movement, and connection beyond their immediate environment.</p>
						</div>
					</div>
				</section>

				<section id="impact">
					<div className="section-inner">
						<div className="overlay-text">
							<span className="eyebrow">Impact</span>
							<h2>Impact</h2>
							<p className="body-text">UNBOUND is not only about technical knowledge. It is also about the feeling of possibility that drones can create.</p>
							<p className="body-text">Create a visible local space for drone curiosity and beginner learning. Help students see drones as a real path into robotics and engineering. Lower the barrier to entry for people who do not know where to start.</p>
							<p className="body-text">Design sessions for children with medical conditions who are often stuck inside. Use drone experiences to create joy, exploration, and a sense of freedom. Show that engineering can also be compassionate and human-centered.</p>
						</div>
					</div>
				</section>

				<section id="contact">
					<div className="section-inner">
						<div className="overlay-text center">
							<span className="eyebrow">Get involved</span>
							<h2>Help build UNBOUND</h2>
							<p className="body-text">UNBOUND is looking for students, mentors, educators, community partners, and supporters who want to help expand drone education and create meaningful outreach experiences.</p>
							<div className="btn-group">
								<a href="mailto:unbounddrones@gmail.com" className="btn btn-primary">Email us</a>
								<a href="https://instagram.com/" target="_blank" rel="noopener noreferrer" className="btn btn-outline">Instagram</a>
							</div>
						</div>
					</div>
				</section>

				<footer>
					<div className="footer-inner">
						<span>&copy; 2026 UNBOUND</span>
						<span>Drone education, access, and freedom.</span>
					</div>
				</footer>
			</div>
		</>
	);
}

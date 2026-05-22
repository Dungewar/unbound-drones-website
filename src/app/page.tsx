"use client";

import { useCallback, useState } from "react";

type PageId = "home" | "about" | "programs" | "impact" | "contact";

const navItems: { id: PageId; label: string }[] = [
	{ id: "home", label: "Home" },
	{ id: "about", label: "About" },
	{ id: "programs", label: "Programs" },
	{ id: "impact", label: "Impact" },
	{ id: "contact", label: "Contact" },
];

export default function Home() {
	const [activePage, setActivePage] = useState<PageId>("home");

	const handleNav = useCallback((pageId: PageId) => {
		setActivePage(pageId);
		if (typeof window !== "undefined") {
			window.scrollTo({ top: 0, behavior: "smooth" });
		}
	}, []);

	return (
		<>
			<nav className="nav">
				<div className="container nav-inner">
					<a
						href="/"
						className="brand"
						onClick={(event) => {
							event.preventDefault();
							handleNav("home");
						}}
					>
						<img
							src="/logo-wide.png"
							alt="UNBOUND"
							className="brand-logo"
						/>
						{/* <div>UNBOUND</div> */}
					</a>
					<div className="nav-links">
						{navItems.map((item) => (
							<button
								key={item.id}
								type="button"
								className={`nav-btn ${
									activePage === item.id ? "active" : ""
								}`}
								onClick={() => handleNav(item.id)}
							>
								{item.label}
							</button>
						))}
					</div>
				</div>
			</nav>

			<main>
				<section
					id="home"
					className={`page ${activePage === "home" ? "active" : ""}`}
				>
					<div className="container hero">
						<div className="hero-grid">
							<div>
								<div className="pill">
									Drone Education &bull; Robotics &bull; Access &bull; Community
								</div>
								<h1>UNBOUND</h1>
								<p>
									UNBOUND is an organization built to make drone education
									accessible in San Jose. The goal is to create a place
									where students and beginners can explore drones as a real
									form of robotics through coaching sessions, hands-on builds,
									and flight experiences that feel exciting, creative, and
									meaningful.
								</p>
								<p>
									From learning with DJI Tello to understanding hardware
									connections in FPV drones, and from coding to outreach for
									children who are stuck indoors because of medical
									conditions, UNBOUND is about helping people experience
									curiosity, freedom, and engineering in a way that feels real.
								</p>
								<div className="cta-row">
									<button
										type="button"
										className="btn btn-primary"
										onClick={() => handleNav("programs")}
									>
										Explore programs
									</button>
									<button
										type="button"
										className="btn btn-secondary"
										onClick={() => handleNav("about")}
									>
										Learn more
									</button>
								</div>
							</div>

							<div className="card hero-card">
								<div>
									<div className="mini-label">Vision</div>
									<h3>Give more people access to the world of drones.</h3>
									<p>
										In a place with so much technology, drone education should
										not feel rare or out of reach. UNBOUND exists to turn
										interest into opportunity.
									</p>
								</div>
								<div className="drone-visual" aria-hidden="true">
									<div className="circle one"></div>
									<div className="circle two"></div>
									<div className="circle three"></div>
									<div className="core">FLY</div>
								</div>
							</div>
						</div>
					</div>

					<div className="container section">
						<div className="section-head">
							<h2>What makes UNBOUND different</h2>
							<p>
								This is not a general STEM club and not a sports
								organization. It is centered specifically on drones, flight,
								robotics, and the freedom those experiences can create.
							</p>
						</div>
						<div className="grid-3">
							<div className="feature">
								<h3>Drone-first learning</h3>
								<p>
									Focused specifically on drones rather than broad engineering
									topics, so students can go deeper into flight systems,
									controls, and real-world applications.
								</p>
							</div>
							<div className="feature">
								<h3>Hands-on building</h3>
								<p>
									Students do not just watch demonstrations. They learn
									through hardware connections, components, setup, and
									practical problem-solving.
								</p>
							</div>
							<div className="feature">
								<h3>Freedom and inspiration</h3>
								<p>
									UNBOUND also brings drone experiences to children whose
									medical conditions keep them indoors, helping them feel
									wonder, movement, and connection.
								</p>
							</div>
						</div>
					</div>
				</section>

				<section
					id="about"
					className={`page ${activePage === "about" ? "active" : ""}`}
				>
					<div className="container section">
						<div className="section-head">
							<h2>About UNBOUND</h2>
							<div className="section-copy">
								<p>
									UNBOUND started from a simple realization: despite being in
									the heart of Silicon Valley, there are very few accessible
									opportunities for students to learn about drones in a
									structured, hands-on way.
								</p>
								<p>
									Drones combine hardware, software, control systems, and
									creativity, but for many people, getting started feels
									unclear or inaccessible.
								</p>
								<p>UNBOUND was created to change that.</p>
								<p>
									At the same time, drones represent something more than
									technology. They represent movement, perspective, and
									freedom. That is why UNBOUND also focuses on outreach for
									children who are often confined indoors due to medical
									conditions, helping them experience flight in a way that
									feels real and meaningful.
								</p>
							</div>
						</div>

						<div className="grid-2">
							<div className="impact-card">
								<div className="mini-label">Mission</div>
								<h3>Make drone education more available.</h3>
								<p>
									UNBOUND helps beginners learn what drones really are: not
									just gadgets, but systems that combine hardware, software,
									control, design, and creativity.
								</p>
							</div>
							<div className="impact-card">
								<div className="mini-label">Why the name fits</div>
								<h3>"Unbound" means not limited.</h3>
								<p>
									Drones represent motion, perspective, exploration, and
									freedom. The name reflects both the literal feeling of
									flight and the idea of opening up opportunities that people
									may not otherwise have.
								</p>
							</div>
						</div>

						<div className="impact-card" style={{ marginTop: 18 }}>
							<div className="mini-label">Core idea</div>
							<h3>Engineering that feels alive</h3>
							<p>
								UNBOUND is meant to make robotics feel tangible. Instead of
								only learning abstract concepts, students can connect them
								to something they can build, fly, debug, and understand.
								That makes learning more memorable and more empowering.
							</p>
						</div>
					</div>
				</section>

				<section
					id="programs"
					className={`page ${activePage === "programs" ? "active" : ""}`}
				>
					<div className="container section">
						<div className="section-head">
							<h2>Programs</h2>
							<p>
								UNBOUND can grow through several kinds of sessions, each
								designed to make drones approachable for different ages and
								experience levels.
							</p>
						</div>
						<div className="grid-2">
							<div className="program">
								<div className="mini-label">01</div>
								<h3>Drone Hackathons</h3>
								<p>
									Competitive drone hackathons where participants design and
									code flight solutions for obstacle-based challenges. Teams
									apply programming, problem-solving, and real-time debugging
									skills, with awards recognizing innovation, efficiency,
									and performance.
								</p>
							</div>
							<div className="program">
								<div className="mini-label">02</div>
								<h3>DJI Tello Coaching Sessions</h3>
								<p>
									Beginner-friendly sessions focused on programming DJI Tello
									drones. Students learn to write code to control takeoff,
									landing, movement, and basic flight patterns, while building
									foundational skills in logic, sequencing, and real-time
									control through hands-on challenges.
								</p>
							</div>
							<div className="program">
								<div className="mini-label">03</div>
								<h3>Intro to Drone Robotics</h3>
								<p>
									Sessions introducing how drones connect to robotics concepts
									such as sensors, motors, control systems, stability, and
									communication.
								</p>
								<p>
									Additional workshops focus on FPV drone structure, hardware
									connections, components, and how a drone comes together as a
									complete system.
								</p>
							</div>
							<div className="program">
								<div className="mini-label">04</div>
								<h3>UNBOUND Outreach</h3>
								<p>
									Outreach sessions are designed for patients, especially
									children, who may not be able to go outside. Using drones
									near windows or open spaces, participants can control flight
									and explore the outside world in a safe, guided way, turning
									coding into a tool for curiosity, movement, and connection
									beyond their immediate environment.
								</p>
							</div>
						</div>
					</div>
				</section>

				<section
					id="impact"
					className={`page ${activePage === "impact" ? "active" : ""}`}
				>
					<div className="container section">
						<div className="section-head">
							<h2>Impact</h2>
							<p>
								UNBOUND is not only about technical knowledge. It is also
								about the feeling of possibility that drones can create.
							</p>
						</div>
						<div className="grid-2">
							<div className="impact-card">
								<div className="mini-label">Community</div>
								<h3>Build a drone learning community in San Jose</h3>
								<div className="list">
									<div className="list-item">
										Create a visible local space for drone curiosity and
										beginner learning.
									</div>
									<div className="list-item">
										Help students see drones as a real path into robotics and
										engineering.
									</div>
									<div className="list-item">
										Lower the barrier to entry for people who do not know where
										to start.
									</div>
								</div>
							</div>
							<div className="impact-card">
								<div className="mini-label">Outreach</div>
								<h3>Bring the feeling of flight to kids indoors</h3>
								<div className="list">
									<div className="list-item">
										Design sessions for children with medical conditions who are
										often stuck inside.
									</div>
									<div className="list-item">
										Use drone experiences to create joy, exploration, and a
										sense of freedom.
									</div>
									<div className="list-item">
										Show that engineering can also be compassionate and
										human-centered.
									</div>
								</div>
							</div>
						</div>
					</div>
				</section>

				<section
					id="contact"
					className={`page ${activePage === "contact" ? "active" : ""}`}
				>
					<div className="container section">
						<div className="contact-card">
							<div className="mini-label">Get involved</div>
							<h2>Help build UNBOUND</h2>
							<p>
								UNBOUND is looking for students, mentors, educators,
								community partners, and supporters who want to help expand
								drone education and create meaningful outreach experiences.
							</p>
							<div
								className="cta-row"
								style={{ justifyContent: "center", marginTop: 24 }}
							>
								<a className="btn btn-primary" href="mailto:unbounddrones@gmail.com">
									Email us
								</a>
								<a
									className="btn btn-secondary"
									href="https://instagram.com/"
									target="_blank"
									rel="noopener noreferrer"
								>
									Instagram
								</a>
							</div>
						</div>
					</div>
				</section>
			</main>

			<footer>
				<div className="container footer-row">
					<div>&copy; 2026 UNBOUND</div>
					<div>Drone education, access, and freedom.</div>
				</div>
			</footer>
		</>
	);
}

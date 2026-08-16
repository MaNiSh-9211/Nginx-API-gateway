import React, { useEffect, useRef } from 'react';

export const AnimatedBackground: React.FC = () => {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Create floating particles
        let particles: Array<{
            x: number;
            y: number;
            radius: number;
            speedX: number;
            speedY: number;
            opacity: number;
        }> = [];

        const createParticles = () => {
            particles = [];
            const particleCount = 50;
            for (let i = 0; i < particleCount; i++) {
                particles.push({
                    x: Math.random() * canvas.width,
                    y: Math.random() * canvas.height,
                    radius: Math.random() * 2 + 1,
                    speedX: (Math.random() - 0.5) * 0.5,
                    speedY: (Math.random() - 0.5) * 0.5,
                    opacity: Math.random() * 0.5 + 0.2,
                });
            }
        };

        const resizeCanvas = () => {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
            createParticles();
        };

        resizeCanvas();
        window.addEventListener('resize', resizeCanvas);

        const animate = () => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            // Draw gradient mesh
            const gradient1 = ctx.createRadialGradient(
                canvas.width * 0.2,
                canvas.height * 0.2,
                0,
                canvas.width * 0.2,
                canvas.height * 0.2,
                canvas.width * 0.8
            );
            gradient1.addColorStop(0, 'rgba(124, 58, 237, 0.15)');
            gradient1.addColorStop(1, 'transparent');

            const gradient2 = ctx.createRadialGradient(
                canvas.width * 0.8,
                canvas.height * 0.8,
                0,
                canvas.width * 0.8,
                canvas.height * 0.8,
                canvas.width * 0.8
            );
            gradient2.addColorStop(0, 'rgba(236, 72, 153, 0.1)');
            gradient2.addColorStop(1, 'transparent');

            const gradient3 = ctx.createRadialGradient(
                canvas.width * 0.5,
                canvas.height * 0.5,
                0,
                canvas.width * 0.5,
                canvas.height * 0.5,
                canvas.width * 0.6
            );
            gradient3.addColorStop(0, 'rgba(168, 85, 247, 0.08)');
            gradient3.addColorStop(1, 'transparent');

            ctx.fillStyle = gradient1;
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            ctx.fillStyle = gradient2;
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            ctx.fillStyle = gradient3;
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            // Draw and animate particles
            particles.forEach((particle) => {
                particle.x += particle.speedX;
                particle.y += particle.speedY;

                if (particle.x < 0 || particle.x > canvas.width) particle.speedX *= -1;
                if (particle.y < 0 || particle.y > canvas.height) particle.speedY *= -1;

                ctx.beginPath();
                ctx.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
                ctx.fillStyle = `rgba(168, 85, 247, ${particle.opacity})`;
                ctx.fill();
            });

            requestAnimationFrame(animate);
        };

        animate();

        return () => {
            window.removeEventListener('resize', resizeCanvas);
        };
    }, []);

    return (
        <canvas
            ref={canvasRef}
            className="animated-background-canvas"
            style={{
                position: 'fixed',
                top: 0,
                left: 0,
                width: '100%',
                height: '100%',
                zIndex: -1,
                pointerEvents: 'none',
            }}
        />
    );
};


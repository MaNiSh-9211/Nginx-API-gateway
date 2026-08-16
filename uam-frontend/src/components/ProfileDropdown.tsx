import React, { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { LogoutIcon } from './Icons';

interface ProfileDropdownProps {
    user: {
        displayName: string;
        avatar?: string;
        email: string;
    };
}

export const ProfileDropdown: React.FC<ProfileDropdownProps> = ({ user }) => {
    const [isOpen, setIsOpen] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const navigate = useNavigate();
    const { logout } = useAuth();

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };

        if (isOpen) {
            document.addEventListener('mousedown', handleClickOutside);
        }

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [isOpen]);

    const getInitials = (name: string) => {
        return name
            .split(' ')
            .map((n) => n[0])
            .join('')
            .toUpperCase()
            .slice(0, 2);
    };

    const handleLogout = async () => {
        await logout();
        navigate('/login');
    };

    return (
        <div className="profile-dropdown" ref={dropdownRef}>
            <button
                className="profile-dropdown-trigger"
                onClick={() => setIsOpen(!isOpen)}
                aria-label="Profile menu"
            >
                <div className="user-avatar">
                    {user.avatar ? (
                        <img src={user.avatar} alt={user.displayName} />
                    ) : (
                        getInitials(user.displayName)
                    )}
                </div>
            </button>

            {isOpen && (
                <div className="profile-dropdown-menu">
                    <div className="profile-dropdown-header">
                        <div className="user-avatar-large">
                            {user.avatar ? (
                                <img src={user.avatar} alt={user.displayName} />
                            ) : (
                                getInitials(user.displayName)
                            )}
                        </div>
                        <div className="profile-dropdown-info">
                            <div className="profile-dropdown-name">{user.displayName}</div>
                            <div className="profile-dropdown-email">{user.email}</div>
                        </div>
                    </div>
                    <div className="profile-dropdown-divider"></div>
                    <button
                        className="profile-dropdown-item"
                        onClick={() => {
                            setIsOpen(false);
                            navigate('/account');
                        }}
                    >
                        <span>Account Settings</span>
                    </button>
                    <div className="profile-dropdown-divider"></div>
                    <button
                        className="profile-dropdown-item profile-dropdown-item-danger"
                        onClick={handleLogout}
                    >
                        <LogoutIcon size={16} />
                        <span>Logout</span>
                    </button>
                </div>
            )}
        </div>
    );
};


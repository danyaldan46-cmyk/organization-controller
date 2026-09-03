import React, { useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, NavLink, useNavigate } from 'react-router-dom';
import Login from './pages/Login.jsx';
import Register from './pages/Register.jsx';
import OrgTree from './pages/OrgTree.jsx';
import Profile from './pages/Profile.jsx';
import TaskLog from './pages/TaskLog.jsx';
import Payroll from './pages/Payroll.jsx';
import PayRules from './pages/PayRules.jsx';

function RequireAuth({ children }) {
  const token = localStorage.getItem('token');
  if (!token) return <Navigate to="/login" replace />;
  return children;
}

function Shell({ children }) {
  const navigate = useNavigate();
  function logout() {
    localStorage.removeItem('token');
    navigate('/login');
  }
  return (
      <div className="app-shell">
        <div className="sidebar">
          <h2>Org Controller</h2>
          <nav>
            <NavLink to="/tree" className={({ isActive }) => (isActive ? 'active' : '')}>Hierarchy</NavLink>
            <NavLink to="/tasks" className={({ isActive }) => (isActive ? 'active' : '')}>Task Log</NavLink>
            <NavLink to="/payroll" className={({ isActive }) => (isActive ? 'active' : '')}>Payroll</NavLink>
            <NavLink to="/pay-rules" className={({ isActive }) => (isActive ? 'active' : '')}>Pay Rules</NavLink>
            <NavLink to="/profile/me" className={({ isActive }) => (isActive ? 'active' : '')}>My Profile</NavLink>
          </nav>
          <button className="secondary" style={{ marginTop: 24, width: '100%' }} onClick={logout}>Log out</button>
        </div>
        <div className="main-content">{children}</div>
      </div>
  );
}

export default function App() {
  return (
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/tree" element={<RequireAuth><Shell><OrgTree /></Shell></RequireAuth>} />
          <Route path="/tasks" element={<RequireAuth><Shell><TaskLog /></Shell></RequireAuth>} />
          <Route path="/payroll" element={<RequireAuth><Shell><Payroll /></Shell></RequireAuth>} />
          <Route path="/pay-rules" element={<RequireAuth><Shell><PayRules /></Shell></RequireAuth>} />
          <Route path="/profile/:id" element={<RequireAuth><Shell><Profile /></Shell></RequireAuth>} />
          <Route path="*" element={<Navigate to="/tree" replace />} />
        </Routes>
      </BrowserRouter>
  );
}

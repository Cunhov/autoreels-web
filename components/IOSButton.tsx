export default function IOSButton({
    children,
    onClick,
    variant = 'primary',
    disabled = false,
    className = '',
    type = 'button'
}: {
    children: React.ReactNode;
    onClick?: () => void;
    variant?: 'primary' | 'destructive' | 'secondary' | 'ghost';
    disabled?: boolean;
    className?: string;
    type?: 'button' | 'submit' | 'reset';
}) {
    const baseStyles = "ios-btn px-4 py-3 rounded-xl font-semibold text-[17px] w-full flex items-center justify-center transition-all disabled:opacity-50 disabled:cursor-not-allowed";

    const variants = {
        primary: "bg-ios-blue text-white shadow-sm hover:bg-blue-600",
        destructive: "bg-ios-red text-white shadow-sm hover:bg-red-600",
        secondary: "bg-gray-200 dark:bg-gray-700 text-ios-text hover:bg-gray-300",
        ghost: "bg-transparent text-ios-blue hover:bg-blue-50/10"
    };

    return (
        <button
            type={type}
            onClick={onClick}
            disabled={disabled}
            className={`${baseStyles} ${variants[variant]} ${className}`}
        >
            {children}
        </button>
    );
}

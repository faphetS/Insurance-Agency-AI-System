interface CardProps {
  title: string;
  items: string[];
}

const Card = ({ title, items }: CardProps) => {
  return (
    <div className="bg-neutral-200 p-4 rounded-xl shadow-lg w-[300px] h-[320px] box-border">
      <p className="text-4xl mb-4 text-neutral-800 font-bold text-center">{title}</p>
      <ul className="list-disc list-inside text-2xl space-y-2 text-neutral-700">
        {items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

export default Card;
